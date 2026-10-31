#!/usr/bin/env python3
"""Docs-index server for Jarvis memory — drop-in replacement for chroma-server.py.

Serves the exact same HTTP contract on :3342 (/search /stats /documents /health
/reindex) over the same corpus (memory/*.md), but with no chromadb dependency:

  - Embeddings: exact replica of ChromaDB's default ONNXMiniLM_L6_V2
    (tokenizers + onnxruntime + masked mean-pooling + L2 norm, max_len 256),
    so vectors — and therefore ranking — match the previous stack.
  - Store: plain sqlite (state/docs-index.db) used as an embedding cache keyed
    by content hash; at runtime vectors live in RAM (~N x 384 float32) and
    search is exact brute-force cosine via numpy. At this corpus size exact
    search is both simpler and more correct than HNSW.
  - Reindex is incremental: only chunks whose content changed are re-embedded.

Rollback: the old chroma-server.py + chroma-data/ are left untouched; restoring
the previous launchd plist brings the old stack back as-is.
"""
import os, re, sys, glob, json, time, hashlib, sqlite3, threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

import idle_serve
from urllib.parse import urlparse, parse_qs

import numpy as np

# Serialize index_all(): prevents cascade POST /reindex calls from racing each
# other (each run rewrites the cache; concurrent runs would interleave writes).
_INDEX_LOCK = threading.Lock()

sys.stdout.reconfigure(line_buffering=True)

HOME = os.path.expanduser("~")
JARVIS = os.path.join(HOME, ".claude/jarvis")
DB_PATH = os.environ.get("DOCS_DB", os.path.join(JARVIS, "state/docs-index.db"))
# Jarvis-owned copy of the model; falls back to the chroma cache if missing.
MODEL_DIR = os.environ.get("DOCS_MODEL_DIR", os.path.join(JARVIS, "state/models/all-MiniLM-L6-v2"))
_FALLBACK_MODEL_DIR = os.path.join(HOME, ".cache/chroma/onnx_models/all-MiniLM-L6-v2/onnx")
if not os.path.exists(os.path.join(MODEL_DIR, "model.onnx")):
    MODEL_DIR = _FALLBACK_MODEL_DIR

DIRS = [
    os.path.join(HOME, ".claude/jarvis/memory/"),
    # Memoria di OpenClaw (25/10): senza, cio' che sa Jarvis non lo trovava Claude Code.
    # Solo memory/ e i file di testa: ~/.openclaw intero porterebbe dentro workspace e bozze.
    os.path.join(HOME, ".openclaw/memory/"),
    os.path.join(HOME, ".openclaw/MEMORY.md"),
    os.path.join(HOME, ".openclaw/USER.md"),
    os.path.join(HOME, ".openclaw/OPS-ATTILIO.md"),
]
# Extra memory directories (or single .md files) via CHROMA_EXTRA_DIRS env (colon-separated).
for extra in filter(None, os.environ.get("CHROMA_EXTRA_DIRS", "").split(":")):
    DIRS.append(os.path.expanduser(extra))


# ---------------------------------------------------------------------------
# Embedding — exact replica of chromadb's ONNXMiniLM_L6_V2 default function.
# ---------------------------------------------------------------------------
class MiniLMEmbedder:
    def __init__(self, model_dir):
        import onnxruntime
        from tokenizers import Tokenizer
        self.tokenizer = Tokenizer.from_file(os.path.join(model_dir, "tokenizer.json"))
        self.tokenizer.enable_truncation(max_length=256)
        self.tokenizer.enable_padding(pad_id=0, pad_token="[PAD]")
        so = onnxruntime.SessionOptions()
        self.session = onnxruntime.InferenceSession(
            os.path.join(model_dir, "model.onnx"),
            sess_options=so,
            providers=["CPUExecutionProvider"],
        )

    def __call__(self, texts, batch_size=32):
        out = []
        for i in range(0, len(texts), batch_size):
            batch = self.tokenizer.encode_batch(texts[i:i + batch_size])
            input_ids = np.array([e.ids for e in batch], dtype=np.int64)
            attention_mask = np.array([e.attention_mask for e in batch], dtype=np.int64)
            onnx_input = {
                "input_ids": input_ids,
                "attention_mask": attention_mask,
                "token_type_ids": np.zeros_like(input_ids),
            }
            last_hidden = self.session.run(None, onnx_input)[0]
            mask = np.broadcast_to(np.expand_dims(attention_mask, -1), last_hidden.shape)
            emb = np.sum(last_hidden * mask, 1) / np.clip(mask.sum(1), 1e-9, None)
            norms = np.linalg.norm(emb, axis=1, keepdims=True)
            norms[norms == 0] = 1e-12
            out.append((emb / norms).astype(np.float32))
        return np.vstack(out) if out else np.zeros((0, 384), dtype=np.float32)


embedder = MiniLMEmbedder(MODEL_DIR)


# ---------------------------------------------------------------------------
# SQLite cache + in-memory snapshot
# ---------------------------------------------------------------------------
def _db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""CREATE TABLE IF NOT EXISTS chunks(
        id TEXT PRIMARY KEY,
        file TEXT, path TEXT, scope TEXT,
        chunk_i INTEGER, total_chunks INTEGER,
        size INTEGER, first_line TEXT, indexed_at INTEGER,
        content_hash TEXT, text TEXT, embedding BLOB
    )""")
    return conn

# Snapshot served by /search /stats /documents. Replaced atomically as a whole
# tuple: (ids: list[str], metas: list[dict], texts: list[str], matrix: np.ndarray)
_SNAPSHOT = ([], [], [], np.zeros((0, 384), dtype=np.float32))


def _load_snapshot_from_db():
    global _SNAPSHOT
    conn = _db()
    rows = conn.execute(
        "SELECT id, file, path, scope, chunk_i, total_chunks, size, first_line,"
        " indexed_at, text, embedding FROM chunks"
    ).fetchall()
    conn.close()
    ids, metas, texts, vecs = [], [], [], []
    for r in rows:
        ids.append(r[0])
        metas.append({
            "file": r[1], "path": r[2], "scope": r[3], "size": r[6],
            "chunk": r[4], "total_chunks": r[5], "first_line": r[7],
            "indexed_at": r[8],
        })
        texts.append(r[9])
        vecs.append(np.frombuffer(r[10], dtype=np.float32))
    matrix = np.vstack(vecs) if vecs else np.zeros((0, 384), dtype=np.float32)
    global _BM25
    _BM25 = _build_bm25(texts)
    _SNAPSHOT = (ids, metas, texts, matrix)
    print(f"Snapshot loaded: {len(ids)} chunks", flush=True)


# Ricerca per parole accanto a quella per significato (25/10): il modello locale da 384
# dimensioni capisce male l'italiano; da solo trovava 17/30 frasi prese dai file.
_WORD = re.compile(r"\w{2,}", re.U)
_BM25 = None


def _build_bm25(texts):
    postings, lens = {}, []
    for i, t in enumerate(texts):
        toks = _WORD.findall(t.lower())
        lens.append(len(toks))
        tf = {}
        for w in toks:
            tf[w] = tf.get(w, 0) + 1
        for w, c in tf.items():
            postings.setdefault(w, []).append((i, c))
    n = len(texts)
    avg = (sum(lens) / n) if n else 1.0
    return postings, np.array(lens, dtype=np.float32), avg, n


def _bm25_scores(q):
    postings, lens, avg, n = _BM25
    scores = np.zeros(n, dtype=np.float32)
    for w in set(_WORD.findall(q.lower())):
        plist = postings.get(w)
        if not plist:
            continue
        idf = np.log(1 + (n - len(plist) + 0.5) / (len(plist) + 0.5))
        for i, c in plist:
            scores[i] += idf * c * 2.2 / (c + 1.2 * (0.25 + 0.75 * lens[i] / avg))
    return scores


def get_scope(fp):
    """Derive a scope tag from the file path. Override by setting
    MEMORY_SCOPES_MAP as a JSON object mapping path-substrings to scope names."""
    fp = fp.lower()
    overrides = os.environ.get("MEMORY_SCOPES_MAP")
    if overrides:
        try:
            mapping = json.loads(overrides)
            for needle, scope in mapping.items():
                if needle.lower() in fp:
                    return scope
        except Exception:
            pass
    if "/.openclaw/" in fp: return "openclaw"
    if "/people/" in fp or "/projects/" in fp: return "business"
    if "/procedures/" in fp or "/tools/" in fp or "/daily/" in fp: return "business"
    return "global"


def collect_files():
    """Collect all .md files across DIRS. De-dup by absolute path; excludes
    /archive/ to match dashboard's walkMemoryDir."""
    files = []
    seen_paths = set()
    for d in DIRS:
        cands = [d] if os.path.isfile(d) else glob.glob(os.path.join(d, "**/*.md"), recursive=True) if os.path.isdir(d) else []
        if cands:
            for f in cands:
                if "/archive/" in f or "/node_modules/" in f:
                    continue
                ap = os.path.abspath(f)
                if ap in seen_paths:
                    continue
                seen_paths.add(ap)
                files.append(ap)
    return files


CHUNK_CHARS = 900  # il modello tronca a 256 token (~900 caratteri): oltre, il testo non si trova


def split_chunks(content):
    """Pezzi da ~900 caratteri, tagliati sui paragrafi, con la prima riga del file davanti
    (titolo o frontmatter danno contesto). Prima erano 6000 caratteri e il modello ne
    leggeva il 15%: 25/10, frasi dalla coda dei file trovate 5 volte su 30."""
    head = content.split("\n", 1)[0][:120]
    paras, buf, out = re.split(r"\n\s*\n", content), "", []
    for para in paras:
        while len(para) > CHUNK_CHARS:  # paragrafo lunghissimo: a fette
            if buf:
                out.append(buf); buf = ""
            out.append(para[:CHUNK_CHARS]); para = para[CHUNK_CHARS - 100:]
        if buf and len(buf) + len(para) + 2 > CHUNK_CHARS:
            out.append(buf); buf = ""
        buf = f"{buf}\n\n{para}" if buf else para
    if buf:
        out.append(buf)
    return [c if i == 0 or c.startswith(head) else f"{head}\n{c}" for i, c in enumerate(out)]


def index_all():
    """(Re)index all .md files. Incremental: chunks whose content hash is
    unchanged reuse the cached embedding; only new/changed chunks are embedded.
    Serialized via _INDEX_LOCK — concurrent calls return {"skipped": True}."""
    acquired = _INDEX_LOCK.acquire(blocking=False)
    if not acquired:
        print("Indexing already in progress — skipping concurrent call", flush=True)
        return {"skipped": True, "reason": "already_in_progress"}
    try:
        files = collect_files()
        print(f"Indexing {len(files)} files...", flush=True)
        now = int(time.time())

        # Desired chunk set (same chunking as chroma-server.py)
        desired = []  # (cid, text, meta, content_hash)
        for fp in files:
            try:
                content = open(fp).read().strip()
                if not content or len(content) < 10:
                    continue
                scope = get_scope(fp)
                name = os.path.basename(fp)
                doc_id = hashlib.md5(fp.encode()).hexdigest()
                chunks = split_chunks(content)
                for ci, chunk in enumerate(chunks):
                    cid = f"{doc_id}_{ci}" if len(chunks) > 1 else doc_id
                    meta = {
                        "file": name, "path": fp, "scope": scope,
                        "size": len(content), "chunk": ci,
                        "total_chunks": len(chunks),
                        "first_line": content.split("\n")[0][:100],
                        "indexed_at": now,
                    }
                    chash = hashlib.sha1(chunk.encode()).hexdigest()
                    desired.append((cid, chunk, meta, chash))
            except Exception as e:
                print(f"  ERR {fp}: {e}", flush=True)

        conn = _db()
        cached = {r[0]: (r[1], r[2]) for r in conn.execute(
            "SELECT id, content_hash, embedding FROM chunks")}

        to_embed = [(i, d) for i, d in enumerate(desired)
                    if d[0] not in cached or cached[d[0]][0] != d[3]]
        embeddings = [None] * len(desired)
        for i, d in enumerate(desired):
            if d[0] in cached and cached[d[0]][0] == d[3]:
                embeddings[i] = np.frombuffer(cached[d[0]][1], dtype=np.float32)
        if to_embed:
            print(f"  Embedding {len(to_embed)}/{len(desired)} changed chunks...", flush=True)
            new_vecs = embedder([d[1] for _, d in to_embed])
            for (i, _), v in zip(to_embed, new_vecs):
                embeddings[i] = v

        # Rewrite cache: upsert all desired rows, drop stale ones
        desired_ids = {d[0] for d in desired}
        conn.executemany(
            "INSERT OR REPLACE INTO chunks(id, file, path, scope, chunk_i,"
            " total_chunks, size, first_line, indexed_at, content_hash, text,"
            " embedding) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            [(d[0], d[2]["file"], d[2]["path"], d[2]["scope"], d[2]["chunk"],
              d[2]["total_chunks"], d[2]["size"], d[2]["first_line"],
              d[2]["indexed_at"], d[3], d[1],
              np.asarray(embeddings[i], dtype=np.float32).tobytes())
             for i, d in enumerate(desired)])
        stale = [(cid,) for cid in cached if cid not in desired_ids]
        if stale:
            conn.executemany("DELETE FROM chunks WHERE id = ?", stale)
        conn.commit()
        conn.close()

        _load_snapshot_from_db()

        stats = {}
        for d in desired:
            stats[d[2]["scope"]] = stats.get(d[2]["scope"], 0) + 1
        n_files = len(set(d[2]["file"] for d in desired))
        print(f"Indexed {len(desired)} chunks from {n_files} files."
              f" Scopes: {stats} (embedded {len(to_embed)}, reused"
              f" {len(desired) - len(to_embed)})", flush=True)
        return {"chunks": len(desired), "files": n_files, "scopes": stats}
    finally:
        _INDEX_LOCK.release()


def search(q, scope, limit):
    ids, metas, texts, matrix = _SNAPSHOT
    if not ids:
        return []
    qv = embedder([q])[0]
    scores = matrix @ qv
    # fusione per posizione (RRF): conta il rango in ciascuna classifica, non le scale
    rrf = np.zeros(len(ids), dtype=np.float32)
    for sc in (scores, _bm25_scores(q)):
        rank = np.empty(len(ids), dtype=np.float32)
        rank[np.argsort(-sc)] = np.arange(len(ids))
        rrf += 1.0 / (60 + rank)
    order = np.argsort(-rrf)
    hits, seen = [], set()
    for i in order:
        if scope and metas[i]["scope"] != scope:
            continue
        if metas[i]["path"] in seen:  # un file solo una volta, col suo pezzo migliore
            continue
        seen.add(metas[i]["path"])
        hits.append({
            "id": ids[i],
            "text": texts[i][:500],
            "score": float(scores[i]),
            "metadata": metas[i],
        })
        if len(hits) >= limit:
            break
    return hits


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # Suppress default logging

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, data, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self._cors()
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)

        if parsed.path == "/search":
            q = params.get("q", [""])[0]
            scope = params.get("scope", [None])[0]
            limit = int(params.get("limit", ["5"])[0])
            if not q:
                self._json({"error": "q required"}, 400)
                return
            try:
                self._json({"results": search(q, scope, limit), "query": q, "scope": scope})
            except Exception as e:
                self._json({"error": str(e)}, 500)

        elif parsed.path == "/stats":
            try:
                _, metas, _, _ = _SNAPSHOT
                scopes = {}
                files = set()
                for m in metas:
                    s = m.get("scope", "unknown")
                    scopes[s] = scopes.get(s, 0) + 1
                    files.add(m.get("file", ""))
                self._json({"total_chunks": len(metas), "total_files": len(files), "by_scope": scopes})
            except Exception as e:
                self._json({"error": str(e)}, 500)

        elif parsed.path == "/documents":
            scope = params.get("scope", [None])[0]
            try:
                _, metas, _, _ = _SNAPSHOT
                seen = {}
                for m in metas:
                    if scope and m.get("scope") != scope:
                        continue
                    f = m.get("file", "")
                    if f not in seen:
                        seen[f] = {
                            "file": f,
                            "scope": m.get("scope", ""),
                            "size": m.get("size", 0),
                            "first_line": m.get("first_line", ""),
                            "chunks": m.get("total_chunks", 1),
                            "indexed_at": m.get("indexed_at", 0),
                        }
                self._json({"documents": list(seen.values())})
            except Exception as e:
                self._json({"error": str(e)}, 500)

        elif parsed.path == "/health":
            self._json({"status": "ok"})

        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/reindex":
            try:
                result = index_all()
                self._json({"ok": True, **result})
            except Exception as e:
                self._json({"error": str(e)}, 500)
        else:
            self._json({"error": "not found"}, 404)


if __name__ == "__main__":
    port = int(os.environ.get("DOCS_PORT", "3342"))
    # Bind to 127.0.0.1 by default. CHROMA_BIND kept for compat with the old
    # server's env knob; DOCS_BIND wins if both are set.
    host = os.environ.get("DOCS_BIND", os.environ.get("CHROMA_BIND", "127.0.0.1"))
    # launchd may hand us the listening socket (Sockets in the plist); without
    # it we bind ourselves and stay up, as a manual run expects.
    listener = idle_serve.activated_socket()
    server = ThreadingHTTPServer((host, port), Handler, bind_and_activate=listener is None)
    if listener is not None:
        idle_serve.adopt(server, listener)
    idle_s = idle_serve.idle_seconds("DOCS_IDLE_EXIT_S") if listener is not None else 0
    print(f"Docs-index server running on http://{host}:{server.server_port} (model: {MODEL_DIR}, idle exit: {idle_s or 'off'})", flush=True)
    # Serve the cached snapshot immediately; refresh in the background.
    try:
        _load_snapshot_from_db()
    except Exception as e:
        print(f"Snapshot load error: {e}", flush=True)
    threading.Thread(target=lambda: index_all(), daemon=True).start()
    idle_serve.serve_until_idle(server, idle_s)
