#!/usr/bin/env python3
# Chiamato da offload-guard.sh (quindi gia' registrato in Claude Code, Codex, Muse, jcode) quando il
# comando contiene pkill, pgrep o killall. Stesso protocollo: JSON su stdin, exit 2 + motivo su stderr.
# Perche': il 25/10 alle 16:36 `pkill -f "^sleep 300$" -P 1` ha ucciso il gateway OpenClaw e mezzo
# launchd. Su macOS pkill, pgrep e killall usano getopt senza riordino: dal primo argomento senza
# trattino in poi TUTTO e' un pattern, anche "-P" e "1". Il filtro sul padre sparisce, e il pattern
# "1" prende ogni processo con un 1 negli argomenti (162 processi contro 0 col filtro al suo posto).
# Blocca solo questo: opzioni scritte dopo il pattern. NON propone nessuna riga riscritta: una riga "corretta"
# ricavata dal testo (con `$(...)`, eval, trap, heredoc, here-string, `echo "..." | sh`) arrivava a prendere 509
# processi. Spiega a parole e dice lo schema generico. Sul testo grezzo c'e' anche un controllo di riserva
# (raw_backup): dentro ogni `$(...)` o backtick che la shell eseguirebbe, anche fra virgolette e nel bersaglio
# di una redirezione o di una here-string, un pkill/pgrep/killall con opzioni dopo il pattern blocca, dovunque
# stia nel comando. Lo legge sul testo pulito dai dati: corpi degli heredoc e parole fra apici o virgolette sono
# testo (giro 7: il giro 6 leggeva il grezzo e fermava `git commit -m "$(cat <<'EOF' ... EOF)"`).
# Barra: kill-guard-test.sh
import json, os, re, shlex, sys
from types import SimpleNamespace

KILLERS = {"pkill", "pgrep", "killall"}
SHELLS = {"sh", "bash", "zsh", "dash", "ksh"}
KILLER_RE = re.compile(r"pkill|pgrep|killall")
# opzioni che vogliono un argomento
# (dalle stringhe getopt dei binari: pgrep/pkill `DF:G:ILP:U:ac:d:fg:ilnoqt:u:vx`, killall `c:dej:Ilmqst:u:vz`)
ARG_OPTS = {"pkill": set("FGPUcgtu"), "pgrep": set("FGPUcdgtu"), "killall": set("cjtu")}
# comandi che ne lanciano un altro, con le lettere delle loro opzioni che vogliono un argomento
WRAPPERS = {"sudo": "ughprCDRtUT", "doas": "uC", "env": "uCSP", "xargs": "EIJLnPRSsda", "timeout": "ks",
            "nice": "nL", "caffeinate": "tw", "exec": "a", "time": "fo", "nohup": "", "command": "",
            "builtin": "", "setsid": "", "unbuffer": "", "stdbuf": "ioe", "ionice": "cnp", "arch": ""}
# parole che stanno prima del comando senza cambiarne il senso
KEYWORDS = {"if", "then", "else", "elif", "do", "while", "until", "!", "{", "(", "$"}
SEPS = set(";&|()<>")
# un segnale e' un numero o un nome vero: `-DP` o `-IP` non lo sono (pkill li legge come `-D -P <parola dopo>`)
SIGNAL_NAMES = ("HUP INT QUIT ILL TRAP ABRT EMT FPE KILL BUS SEGV SYS PIPE ALRM TERM URG STOP TSTP CONT CHLD "
                "TTIN TTOU IO XCPU XFSZ VTALRM PROF WINCH INFO USR1 USR2").replace(" ", "|")
SIGNAL = re.compile(r"^-(\d+|(?:SIG)?(?:" + SIGNAL_NAMES + "))$")
# redirezione a inizio parola: `2>/dev/null`, `>&2`, `&>f`, `<in`; non `<(` ne' `>(`
REDIR_OP = re.compile(r"\d*(?:&>>?|>>|>\||>&|<<<|<<-?|<&|<>|>|<)(?!\()")
REDIR_TOKEN = re.compile(r"^__KGREDIR(\d+)__$")
HERE_TOKEN = re.compile(r"^__KGHERE(\d+)__$")
SUB_WORD = "__KGSUB__"


def normalize(text):
    """Unisce le righe spezzate con \\ a capo (prima di dividere per righe)."""
    return text.replace("\\\n", "")


ANSI_ESC = {"n": "\n", "t": "\t", "r": "\r", "a": "\a", "b": "\b", "f": "\f", "v": "\v", "e": "\x1b", "E": "\x1b"}


def ansi_end(text, j):
    """j sull'apice di `$'...'` (la stringa alla C di bash e zsh): indice dopo l'apice che la chiude, -1 se resta
    aperta. Dentro, `\\'` non chiude: senza questo `$'l\\'ultimo'` sfasava tutte le virgolette dopo."""
    n, j = len(text), j + 1
    while j < n:
        if text[j] == "\\":
            j += 2
        elif text[j] == "'":
            return j + 1
        else:
            j += 1
    return -1


def ansi_text(body):
    """Il testo vero di `$'...'` (senza gli apici): `\\n` e' un a capo, `\\'` un apostrofo."""
    return re.sub(r"\\(.)", lambda m: ANSI_ESC.get(m.group(1), m.group(1) if m.group(1) in "'\"\\?" else m.group(0)),
                  body, flags=re.S)


def skip_dq(text, j):
    """j subito dopo una virgoletta doppia aperta: indice dopo quella che chiude (le `$(...)` dentro contano)."""
    n = len(text)
    while j < n:
        ch = text[j]
        if ch == "\\":
            j += 2
        elif ch == '"':
            return j + 1
        elif text.startswith("$(", j):
            k = match_paren(text, j + 2)
            if k < 0:
                return n
            j = k + 1
        else:
            j += 1
    return n


def match_paren(text, j):
    """j subito dopo `$(`: indice della `)` che chiude, o -1 se il testo finisce prima. I corpi degli heredoc
    dentro la sostituzione (`$(cat <<'EOF' ... EOF)`, l'idioma dei messaggi di commit) sono testo: un apostrofo
    li dentro non apre nessuna virgoletta."""
    depth, n, pending = 1, len(text), []
    while j < n:
        ch = text[j]
        if ch == "\\":
            j += 2
            continue
        if ch == "\n" and pending:
            j += 1
            for delim, strip in pending:
                j = read_heredoc(text, j, delim, strip)[1]
            pending = []
            continue
        if text.startswith("<<", j) and not text.startswith("<<<", j):
            k = j + 2
            strip = text.startswith("-", k)
            k += 1 if strip else 0
            while k < n and text[k] in " \t":
                k += 1
            e = word_end(text, k)
            if e > k:
                pending.append((re.sub(r"['\"\\]", "", text[k:e]), strip))
                j = e
                continue
        if text.startswith("$'", j):
            k = ansi_end(text, j + 1)
            j = n if k < 0 else k
            continue
        if ch == "'":
            k = text.find("'", j + 1)
            j = n if k < 0 else k + 1
            continue
        if ch == '"':
            j = skip_dq(text, j + 1)
            continue
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return j
        j += 1
    return -1


def extract_subs(text):
    """Le `$(...)` e i backtick di un testo (per i corpi degli heredoc senza apici, che la shell espande)."""
    subs, i, n = [], 0, len(text)
    while i < n:
        if text[i] == "\\":
            i += 2
        elif text[i] == "`":
            j = text.find("`", i + 1)
            if j < 0:
                break
            subs.append(text[i + 1:j])
            i = j + 1
        elif text.startswith("$(", i):
            j = match_paren(text, i + 2)
            if j < 0:
                break
            subs.append(text[i + 2:j])
            i = j + 1
        else:
            i += 1
    return subs


def word_end(text, j):
    """Fine della parola che comincia in j (virgolette incluse), per il bersaglio di una redirezione."""
    n = len(text)
    while j < n:
        ch = text[j]
        if text.startswith("$'", j):
            k = ansi_end(text, j + 1)
            j = n if k < 0 else k
        elif ch == "'":
            k = text.find(ch, j + 1)
            j = n if k < 0 else k + 1
        elif ch == '"':
            j = skip_dq(text, j + 1)
        elif ch == "`":
            k = text.find("`", j + 1)
            j = n if k < 0 else k + 1
        elif text.startswith("$(", j):
            k = match_paren(text, j + 2)
            j = n if k < 0 else k + 1
        elif ch == "\\":
            j += 2
        elif ch in " \t\n;&|()<>":
            break
        else:
            j += 1
    return min(j, n)


def read_heredoc(text, i, delim, strip_tabs):
    """Il corpo che comincia in i e finisce alla riga uguale al delimitatore (con `<<-` i tab iniziali
    non contano). Ritorna (corpo, indice dopo la riga del delimitatore). Senza delimitatore il corpo
    non si consuma: le righe restano comandi (meglio un blocco in piu' che un pkill nascosto)."""
    n, pos, lines = len(text), i, []
    while pos <= n:
        k = text.find("\n", pos)
        line = text[pos:] if k < 0 else text[pos:k]
        if (line.lstrip("\t") if strip_tabs else line) == delim:
            return "\n".join(lines), (n if k < 0 else k + 1)
        if k < 0:
            break
        lines.append(line)
        pos = k + 1
    return "", i


def prepare(text):
    """Un solo passaggio che conosce le virgolette. Toglie i commenti, trasforma le redirezioni in
    gettoni a parte (`2>/dev/null` non e' un argomento), mette i corpi degli heredoc da parte (sono
    dati, a meno che li legga una shell), estrae `$(...)` e backtick FUORI dagli apici singoli (dentro
    sono testo), e cambia gli a-capo fuori dalle virgolette in `;`. Anche le sostituzioni scritte nel
    bersaglio di una redirezione o di una here-string (`<<< "$(...)"`) si estraggono.
    ValueError se le virgolette restano aperte."""
    text = normalize(text)
    n = len(text)
    out, redirs, subs, heres, pending = [], [], [], [], []
    i, q, wordstart = 0, None, True

    def take_sub(i):
        """i sul backtick o su `$(`: salva il contenuto, lascia una parola segnaposto, ritorna l'indice dopo."""
        if text[i] == "`":
            j = i + 1
            while j < n and text[j] != "`":
                j += 2 if text[j] == "\\" else 1
            if j >= n:
                raise ValueError("backtick aperto")
            subs.append(text[i + 1:j])
            end = j + 1
        else:
            j = match_paren(text, i + 2)
            if j < 0:
                raise ValueError("sostituzione aperta")
            subs.append(text[i + 2:j])
            end = j + 1
        out.append(SUB_WORD)
        return end

    while i < n:
        c = text[i]
        if q == "'":
            if c == "'":
                q = None
            out.append(c)
            i += 1
            continue
        if q == '"':
            if c == "\\" and i + 1 < n:
                out.append(text[i:i + 2])
                i += 2
                continue
            if c == '"':
                q = None
            elif c == "`" or text.startswith("$(", i):
                i = take_sub(i)
                continue
            out.append(c)
            i += 1
            continue
        if c == "\\" and i + 1 < n:
            out.append(text[i:i + 2])
            i += 2
            wordstart = False
            continue
        if text.startswith("$'", i):
            # `$'...'` diventa una stringa fra apici singoli normale col suo testo vero: shlex non la conosce
            k = ansi_end(text, i + 1)
            if k < 0:
                raise ValueError("virgolette aperte")
            out.append(shlex.quote(ansi_text(text[i + 2:k - 1])))
            i, wordstart = k, False
            continue
        if c in "'\"":
            q = c
            out.append(c)
            i += 1
            wordstart = False
            continue
        if c == "\n":
            out.append(" ; ")
            i += 1
            wordstart = True
            while pending:
                idx, delim, strip, quoted = pending.pop(0)
                body, i = read_heredoc(text, i, delim, strip)
                heres[idx] = (body, quoted)
            continue
        if c == "#" and wordstart:
            j = text.find("\n", i)
            i = n if j < 0 else j
            continue
        if c == "`" or text.startswith("$(", i):
            i = take_sub(i)
            wordstart = False
            continue
        if c == "<" and text.startswith("<<", i) and not text.startswith("<<<", i):
            # heredoc: `<<EOF`, `<<-EOF`, `<<'EOF'`, `<<\EOF`, `<<END-DOC`; il corpo comincia alla riga dopo
            j = i + 2
            strip = text.startswith("-", j)
            if strip:
                j += 1
            while j < n and text[j] in " \t":
                j += 1
            k = word_end(text, j)
            raw = text[j:k]
            if raw:
                pending.append((len(heres), re.sub(r"['\"\\]", "", raw), strip, any(ch in raw for ch in "'\"\\")))
                out.append(f" __KGHERE{len(heres)}__ ")
                heres.append(("", True))
                i, wordstart = k, True
                continue
        if (wordstart or text.startswith("<<<", i)) and c in "<>&0123456789":
            m = REDIR_OP.match(text, i)
            if m:
                j = m.end()
                while j < n and text[j] in " \t":
                    j += 1
                j = word_end(text, j)
                out.append(f" __KGREDIR{len(redirs)}__ ")
                redirs.append(text[i:j])
                subs += [raw for raw, _ in walk(text[i:j])[1]]  # `> "$(...)"`, `<<< "$(...)"`
                i = j
                wordstart = True
                continue
        wordstart = c in " \t;&|()"
        out.append(c)
        i += 1
    if q:
        raise ValueError("virgolette aperte")
    for idx, delim, strip, quoted in pending:
        heres[idx] = ("", quoted)
    return SimpleNamespace(text="".join(out), redirs=redirs, subs=subs, heres=heres)


def lex(text):
    s = shlex.shlex(text, posix=True, punctuation_chars=";&|()<>")
    s.whitespace_split = True
    s.commenters = ""
    return list(s)


def segments(tokens, prep):
    """Divide i gettoni in comandi; ogni segmento e' (parole, redirezioni, heredoc, in_pipe) con in_pipe
    vero se il comando riceve lo stdin dal precedente."""
    words, reds, heres, piped = [], [], [], False
    for t in tokens:
        m, h = REDIR_TOKEN.match(t), HERE_TOKEN.match(t)
        if m:
            reds.append(prep.redirs[int(m.group(1))])
        elif h:
            heres.append(prep.heres[int(h.group(1))])
        elif t and set(t) <= SEPS:
            if words or reds or heres:
                yield words, reds, heres, piped
            words, reds, heres = [], [], []
            piped = t in ("|", "|&")
        else:
            words.append(t)
    if words or reds or heres:
        yield words, reds, heres, piped


def command_start(seg):
    """Indice del comando vero: salta assegnazioni, parole come `if`/`!` e i comandi che ne lanciano un altro
    (`sudo -u root`, `env A=1`, `xargs -I {}`, `timeout 5`), anche scritti col percorso (`/usr/bin/env`)."""
    j, n = 0, len(seg)
    while j < n:
        w = seg[j]
        b = os.path.basename(w)
        if w in KEYWORDS or re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", w):
            j += 1
        elif w == "function":  # `function nome { pkill ...; }`: salta la parola e il nome della funzione
            j += 2
        elif b in WRAPPERS:
            takes = WRAPPERS[b]
            j += 1
            while j < n and len(seg[j]) > 1 and seg[j].startswith("-"):
                opt = seg[j]
                j += 1
                if opt == "--":
                    break
                for k, ch in enumerate(opt[1:]):
                    if ch in takes:
                        if k == len(opt) - 2:  # l'argomento e' il token dopo
                            j += 1
                        break
            if b == "timeout" and j < n and re.fullmatch(r"[0-9.]+[smhd]?", seg[j]):
                j += 1
        else:
            break
    return j


def parse_shell_args(rest):
    """Dopo il nome di una shell: (stringa di `-c` o None, se legge lo script dallo stdin).
    Capisce `-lc`, `-euo pipefail -c "..."`, `-s`, `-` e le opzioni lunghe."""
    j, pending_c, stdin_flag = 0, False, False
    while j < len(rest):
        a = rest[j]
        if a == "--":
            j += 1
            break
        if a == "-":
            stdin_flag = True
            j += 1
        elif a in ("--rcfile", "--init-file"):
            j += 2
        elif len(a) > 1 and a[0] in "-+":
            if a.startswith("--"):
                j += 1
                continue
            letters = a[1:]
            pending_c = pending_c or "c" in letters
            stdin_flag = stdin_flag or "s" in letters
            j += 2 if letters[-1] in "oO" else 1
        else:
            break
    operand = rest[j] if j < len(rest) else None
    if pending_c:
        return operand, False
    return None, stdin_flag or operand is None


def reads_script_from_stdin(seg, ci):
    """Il comando in seg[ci] esegue come script quello che riceve sullo stdin?"""
    base = os.path.basename(seg[ci])
    if base in SHELLS:
        return parse_shell_args(seg[ci + 1:])[1]
    return base in ("source", ".") and seg[ci + 1:ci + 2] in (["/dev/stdin"], ["/dev/fd/0"])


def here_strings(reds):
    """I testi di `<<< "..."` (una shell che li riceve li esegue)."""
    out = []
    for r in reds:
        m = re.match(r"\d*<<<\s*(.*)$", r, re.S)
        if m:
            try:
                out.append(" ".join(shlex.split(m.group(1))))
            except ValueError:
                out.append(m.group(1))
    return out


def hits_in(cmd, depth, loose):
    """Come find_hits ma alza ValueError se non riesce a leggere il comando."""
    prep = prepare(cmd)
    hits, feed = [], []
    for seg, reds, heres, piped in segments(lex(prep.text), prep):
        if not piped:
            feed = []
        ci = command_start(seg)
        for i in (range(len(seg)) if loose else [ci]):
            if i >= len(seg):
                break
            base = os.path.basename(seg[i])
            if base in KILLERS:
                hits.append((base, seg[i + 1:]))
                break
            if depth < 3:
                # bash -c "..." / eval "...": il comando vero sta dentro la stringa. -c vale solo dopo una shell:
                # `grep -c "pkill x -9"` non esegue niente
                inner = None
                if base in SHELLS:
                    inner = parse_shell_args(seg[i + 1:])[0]
                elif base == "eval":
                    inner = " ".join(seg[i + 1:])
                elif base == "trap":
                    # trap 'comando' SEGNALI: la stringa la esegue la shell all'uscita o al segnale
                    ops = [a for a in seg[i + 1:] if a != "--" and not (len(a) > 1 and a.startswith("-"))]
                    inner = ops[0] if ops else None
                if inner and KILLER_RE.search(inner):
                    hits += find_hits(inner, depth + 1)
                    break
        own = [b for b, _ in heres] + here_strings(reds)
        if depth < 3:
            # una shell che legge lo script dallo stdin esegue heredoc, here-string e quel che la pipe le porta
            if ci < len(seg) and reads_script_from_stdin(seg, ci):
                for txt in own + (feed if piped else []):
                    if KILLER_RE.search(txt):
                        hits += find_hits(txt, depth + 1)
            # un heredoc senza apici e' dato, ma `$(...)` e backtick dentro li esegue la shell
            for body, quoted in heres:
                if not quoted and KILLER_RE.search(body):
                    for sub in extract_subs(body):
                        if KILLER_RE.search(sub):
                            hits += find_hits(sub, depth + 1)
        feed += own + seg + [" ".join(seg[1:])]
    for sub in prep.subs:
        if depth < 3 and KILLER_RE.search(sub):
            hits += find_hits(sub, depth + 1)
    return hits


def find_hits(cmd, depth=0):
    """Ritorna [(comando, argomenti)] di ogni pkill/pgrep/killall in posizione di comando.
    Se il testo intero non si legge (virgolette aperte) si analizza riga per riga; la riga che
    ancora non si legge e che nomina un killer si analizza alla grossa (virgolette tolte, il killer
    conta ovunque stia nel comando): meglio un blocco in piu' che una guardia aggirata."""
    try:
        return hits_in(cmd, depth, False)
    except ValueError:
        pass
    hits = []
    for line in normalize(cmd).split("\n"):
        if not KILLER_RE.search(line):
            continue
        try:
            hits += hits_in(line, depth, False)
        except ValueError:
            try:
                hits += hits_in(re.sub(r"['\"`\\]", " ", line), depth, True)
            except ValueError:  # ancora illeggibile (`$(` mai chiuso): si guardano solo le parole
                hits += loose_hits(line)
    return hits


def analyse(name, args):
    """Ritorna (patterns, before_opts, after) con after = token-opzione dopo il primo pattern."""
    takes = ARG_OPTS[name]
    i, opts = 0, []
    if args and SIGNAL.match(args[0]):
        opts.append(args[0])
        i = 1
    while i < len(args):
        a = args[i]
        if a == "--":
            i += 1
            break
        if len(a) < 2 or not a.startswith("-"):
            break
        if name == "killall" and SIGNAL.match(a):
            opts.append(a)
            i += 1
            continue
        opts.append(a)
        i += 1
        for k, ch in enumerate(a[1:]):
            if ch in takes:
                if k == len(a) - 2 and i < len(args):  # l'argomento e' il token dopo
                    opts.append(args[i])
                    i += 1
                break
    rest = args[i:]
    patterns, after = rest[:1], []
    j = 1
    # dopo il primo pattern, ogni token con il trattino e' un'opzione finita al posto sbagliato
    while j < len(rest):
        t = rest[j]
        if len(t) > 1 and t.startswith("-"):
            after.append(t)
            if t[-1] in takes and not SIGNAL.match(t) and j + 1 < len(rest):
                after.append(rest[j + 1])
                j += 1
        else:
            patterns.append(t)
        j += 1
    return opts, patterns, after


def quote(parts):
    return " ".join(shlex.quote(p) for p in parts)


def walk(text):
    """Legge il testo grezzo come lo leggerebbe la shell, senza costruire comandi. Ritorna (pulito, subs):
    pulito = il testo con i DATI cancellati (spazi, stessa lunghezza): il contenuto fra apici singoli, di `$'...'`
    e fra virgolette doppie (non le sostituzioni dentro), i corpi degli heredoc, i commenti; le virgolette restano,
    cosi' un pattern cancellato e' ancora una parola. subs = [(testo, testo pulito)] di ogni `$(...)` e
    backtick che la shell eseguirebbe, anche dentro virgolette doppie e nel bersaglio di una redirezione. Il
    testo fra apici singoli non si esegue mai, e nemmeno un heredoc con apici: li' dentro nessuna sostituzione."""
    n = len(text)
    out, subs, pending = list(text), [], []
    dq, wordstart, i = False, True, 0

    def blank(a, b):
        for k in range(a, min(b, n)):
            if out[k] != "\n":
                out[k] = " "

    while i < n:
        c = text[i]
        if c == "\\":
            if dq:
                blank(i, i + 2)
            i, wordstart = i + 2, False
            continue
        if not dq and text.startswith("$'", i):  # `$'...'`: testo, con `\'` che non chiude
            k = ansi_end(text, i + 1)
            k = n if k < 0 else k
            blank(i + 2, k - 1)
            i, wordstart = k, False
            continue
        if not dq and c == "'":
            k = text.find("'", i + 1)
            k = n if k < 0 else k
            blank(i + 1, k)
            i, wordstart = k + 1, False
            continue
        if c == '"':
            dq, i, wordstart = not dq, i + 1, False
            continue
        if c == "`" or text.startswith("$(", i):
            if c == "`":
                j = i + 1
                while j < n and text[j] != "`":
                    j += 2 if text[j] == "\\" else 1
                end, start = min(j, n), i + 1
            else:
                j = match_paren(text, i + 2)  # non chiusa: si legge fino alla fine, meglio un blocco in piu'
                end, start = (n if j < 0 else j), i + 2
            inner_clean, _ = walk(text[start:end])
            out[start:end] = list(inner_clean)
            subs.append((text[start:end], inner_clean))
            i, wordstart = end + 1, False
            continue
        if not dq and c == "\n":
            i += 1
            for delim, strip, quoted in pending:
                body, nxt = read_heredoc(text, i, delim, strip)
                if quoted:
                    blank(i, nxt)
                else:
                    for sub in extract_subs(body):
                        subs.append((sub, walk(sub)[0]))
                    blank(i, nxt)
                i = nxt
            pending, wordstart = [], True
            continue
        if not dq and c == "#" and wordstart:
            k = text.find("\n", i)
            k = n if k < 0 else k
            blank(i, k)
            i = k
            continue
        if not dq and c == "<" and text.startswith("<<<", i):  # here-string: non e' un heredoc
            i, wordstart = i + 3, True
            continue
        if not dq and c == "<" and text.startswith("<<", i):
            j = i + 2
            strip = text.startswith("-", j)
            j += 1 if strip else 0
            while j < n and text[j] in " \t":
                j += 1
            k = word_end(text, j)
            raw = text[j:k]
            if raw:
                pending.append((re.sub(r"['\"\\]", "", raw), strip, any(ch in raw for ch in "'\"\\")))
                i, wordstart = k, True
                continue
        if dq:  # fra virgolette doppie il testo e' una parola sola: `"pgrep"` argomento di grep non e' un comando
            blank(i, i + 1)
        wordstart = c in " \t\n;&|()"
        i += 1
    return "".join(out), subs


KILLER_WORD = re.compile(r"(?<![\w.-])(pkill|pgrep|killall)(?![\w-])")


def loose_hits(text):
    """Ogni pkill/pgrep/killall del testo con gli argomenti fino al primo separatore, virgolette tolte.
    Senza capire la sintassi: serve per il controllo di riserva e per il testo che non si riesce a leggere."""
    hits = []
    for m in KILLER_WORD.finditer(text):
        rest = re.split(r"[;&|()<>\n`]|\$\(", text[m.end():], 1)[0]
        hits.append((m.group(1), re.sub(r"['\"\\]", " ", rest).split()))
    return hits


def clean_words(clean):
    """Ogni pkill/pgrep/killall del testo PULITO di una sostituzione (apici singoli, corpi degli heredoc e commenti
    gia' cancellati da walk), dovunque stia nel comando, anche dietro un wrapper che l'analisi non conosce, con
    un'opzione dopo il suo primo argomento senza trattino. Le virgolette si leggono con shlex: `"codex exec -m x"`
    e' un argomento solo, e un `'^sleep 300$'` cancellato resta una parola (fatta di spazi). Se le virgolette non
    tornano si legge alla grossa: meglio un blocco in piu'."""
    try:
        toks = lex(clean.replace("\n", " ; "))
    except ValueError:
        return [(n, after) for n, a in loose_hits(clean) for after in [analyse(n, a)[2]] if after]
    hits, seg = [], []
    for t in toks + [";"]:
        if t and set(t) <= SEPS:
            for k, w in enumerate(seg):
                name = os.path.basename(w)
                if name in KILLERS:
                    after = analyse(name, seg[k + 1:])[2]
                    if after:
                        hits.append((name, after))
            seg = []
        else:
            seg.append(t)
    return hits


def raw_backup(cmd, depth=0):
    """Controllo di riserva sul testo grezzo, indipendente da prepare(): dentro ogni `$(...)` o backtick che la
    shell eseguirebbe (anche fra virgolette doppie, nel bersaglio di una redirezione o di una here-string, e
    annidati) cerca un pkill/pgrep/killall con un'opzione dopo il primo argomento senza trattino, letto sul testo
    pulito dai dati: gli heredoc e le parole fra apici restano testo (`$(cat <<'EOF' ... EOF)` dei messaggi di
    commit, `$(grep -rn 'pkill' .)`). Ritorna [(comando, opzioni dopo il pattern)]. Falsi rifiuti accettati, ma
    solo dentro sostituzioni che verrebbero eseguite: `$(grep -rn pkill src --include=x)`, senza apici, si ferma."""
    hits = []
    for raw, clean in walk(normalize(cmd) if depth == 0 else cmd)[1]:
        hits += clean_words(clean)
        if depth < 6:
            hits += raw_backup(raw, depth + 1)
    return hits


def main():
    raw = sys.stdin.read()
    try:
        data = json.loads(raw)
    except ValueError:
        return 0
    cmd = (data.get("tool_input") or {}).get("command") or data.get("command") or ""
    if not isinstance(cmd, str) or not KILLER_RE.search(cmd.replace("\\\n", "")):
        return 0
    found = []
    for name, args in find_hits(cmd, 0):
        after = analyse(name, args)[2]
        if not after:
            continue
        found.append((name, after))
    found += raw_backup(cmd)
    if not found:
        return 0
    name, after = found[0]
    # Niente riga riscritta: una "correzione" ricavata dal testo puo' prendere centinaia di processi.
    sys.stderr.write(
        f"Bloccato: {name} con opzioni dopo il pattern ({quote(after)}).\n"
        f"Su macOS {name} smette di leggere le opzioni al primo argomento senza trattino: "
        f"quelle dopo diventano ALTRI PATTERN. Il 25/10 `pkill -f \"^sleep 300$\" -P 1` ha preso ogni processo "
        f"con un 1 negli argomenti (gateway OpenClaw, launchd, widget) invece dei figli di launchd.\n"
        f"Su macOS le opzioni vanno prima del pattern: pkill [opzioni] -f 'pattern'. "
        f"Per fermare un tuo processo usa il suo PID o pkill -P <tuo ppid>.\n"
        f"Prima guarda chi prende, senza uccidere: pgrep -l (o killall -s) con le stesse opzioni.\n"
    )
    return 2


if __name__ == "__main__":
    sys.exit(main())
