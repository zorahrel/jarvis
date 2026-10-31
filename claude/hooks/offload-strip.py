#!/usr/bin/env python3
# Filtro di offload-guard.sh: legge un comando shell su stdin e stampa solo il testo che la shell
# ESEGUE, cioe' senza i corpi dei heredoc (<<EOF, <<'EOF', <<-EOF), senza il contenuto delle stringhe
# tra apici o virgolette e senza i commenti. Cosi' `echo "run pytest later"`, `grep 'tsc' f` e un
# heredoc con «pytest» dentro a una regex non sembrano suite pesanti (falso positivo del 25/10).
# Restano visibili, perche' la shell le esegue:
#  - la stringa di `bash -c`, `sh -c`, `zsh -lc`... e di `eval` (anche dentro `timeout 5 bash -c "..."`);
#  - il corpo di un heredoc dato in pasto a una shell (`bash <<EOF`);
#  - i `$( )` e i backtick, anche dentro virgolette doppie o heredoc non quotati.
# Non e' un parser di shell: e' un tokenizer a stati. Se qualcosa va storto, l'hook usa il testo intero.
import os
import re
import sys

SHELLS = {"bash", "sh", "zsh", "dash", "ksh"}
MAX_DEPTH = 6
SEP = re.compile(r"[;&|(){}\n`]")


def exec_ctx(tail):
    # la prossima stringa e' codice eseguito? (`bash -lc `, `eval `)
    words = SEP.split(tail)[-1].split()
    if not words:
        return False
    if words[-1] == "eval":
        return True
    return bool(re.fullmatch(r"-[A-Za-z]*c", words[-1])) and any(
        os.path.basename(w) in SHELLS for w in words[:-1]
    )


def shell_fed(tail):
    # il segmento corrente e' una shell (`cat x | bash <<EOF`): il corpo del heredoc e' codice
    return any(os.path.basename(w) in SHELLS for w in SEP.split(tail)[-1].split())


def substitutions(text):
    # corpo dei $( ) (non $(( )) ) e dei backtick dentro un testo
    found = []
    i = 0
    while i < len(text):
        if text.startswith("$((", i):
            i += 3
            continue
        if text.startswith("$(", i):
            depth, j = 1, i + 2
            while j < len(text) and depth:
                depth += (text[j] == "(") - (text[j] == ")")
                j += 1
            found.append(text[i + 2 : j - 1 if depth == 0 else j])
            i = j
            continue
        if text[i] == "`":
            j = text.find("`", i + 1)
            if j < 0:
                break
            found.append(text[i + 1 : j])
            i = j + 1
            continue
        if text[i] == "\\":
            i += 1
        i += 1
    return found


def strip(s, depth=0):
    if depth > MAX_DEPTH:
        return ""
    out = []
    pending = []  # heredoc in attesa del prossimo a capo: (delimitatore, tab, tenere, quotato)
    i, n = 0, len(s)

    def tail():
        return "".join(out)[-400:]

    while i < n:
        c = s[i]
        if c == "\\":
            out.append(s[i : i + 2] if s[i + 1 : i + 2] != "\n" else " ")
            i += 2
        elif c == "'":
            j = s.find("'", i + 1)
            j = n if j < 0 else j
            body = s[i + 1 : j]
            out.append(" " + strip(body, depth + 1) + " " if exec_ctx(tail()) else '""')
            i = j + 1
        elif c == '"':
            j, buf = i + 1, []
            while j < n and s[j] != '"':
                if s[j] == "\\" and j + 1 < n:
                    buf.append(s[j : j + 2])
                    j += 2
                else:
                    buf.append(s[j])
                    j += 1
            raw = "".join(buf)
            if exec_ctx(tail()):
                out.append(" " + strip(re.sub(r'\\(["\\$`])', r"\1", raw), depth + 1) + " ")
            else:
                out.append('""')
                for sub in substitutions(raw):
                    out.append(" ; " + strip(sub, depth + 1) + " ; ")
            i = j + 1
        elif c == "#" and (i == 0 or s[i - 1] in " \t\n;&|("):
            j = s.find("\n", i)
            i = n if j < 0 else j
        elif s.startswith("<<", i) and not s.startswith("<<<", i):
            j = i + 2
            dash = j < n and s[j] == "-"
            j += dash
            while j < n and s[j] in " \t":
                j += 1
            quoted = j < n and s[j] in "'\""
            if quoted:
                q = s[j]
                k = s.find(q, j + 1)
                k = n if k < 0 else k
                delim = s[j + 1 : k]
                j = k + 1
            else:
                m = re.match(r"[^\s;&|()<>]+", s[j:])
                word = m.group(0) if m else ""
                quoted = "\\" in word or "'" in word or '"' in word
                delim = re.sub(r"[\\'\"]", "", word)
                j += len(word)
            pending.append((delim, dash, shell_fed(tail()), quoted))
            out.append(" ")
            i = j
        elif c == "\n" and pending:
            out.append("\n")
            i += 1
            for delim, dash, keep, quoted in pending:
                body = []
                while i < n:
                    k = s.find("\n", i)
                    k = n if k < 0 else k
                    line = s[i:k]
                    i = min(k + 1, n)
                    if (line.lstrip("\t") if dash else line) == delim:
                        break
                    body.append(line)
                text = "\n".join(body)
                if keep:
                    out.append(strip(text, depth + 1) + "\n")
                elif not quoted:
                    for sub in substitutions(text):
                        out.append(strip(sub, depth + 1) + "\n")
            pending = []
        else:
            out.append(c)
            i += 1
    return "".join(out)


if __name__ == "__main__":
    sys.stdout.write(strip(sys.stdin.read()))
