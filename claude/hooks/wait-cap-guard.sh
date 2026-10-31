#!/bin/bash
# PreToolUse(Bash) per Claude Code, Codex e Muse; `pre_tool` per jcode. Stesso protocollo di
# offload-guard.sh: exit 2 + motivo su stderr; jcode passa l'input nudo ({"command": ...}) col
# nome dello strumento in JCODE_HOOK_TOOL_NAME.
# Ferma un'attesa senza tetto: un ciclo until/while che dorme (sleep) o un tail -f, senza niente
# che lo faccia finire da solo. Perche': il 25/10 15 attese su 25 delle sessioni non avevano un
# tetto e una aspettava il PC da 17 h; un comando in primo piano oltre i 120 s passa in
# background da solo, quindi conta anche senza run_in_background. Un server lanciato in
# background (dev, anteprima) non e' un'attesa: lo raccoglie devreap, qui passa.
# Tetti riconosciuti: $SECONDS, date +%s (o EPOCHSECONDS) confrontata, seq, un contatore che
# cresce e si confronta con un numero, timeout N o perl -e 'alarm N; exec @ARGV' (anche -we) solo davanti a una
# shell -c che contiene l'attesa (o davanti al tail -f stesso; N letterale e > 0). Lascia passare
# WAIT_CAP=off davanti (attesa che deve restare aperta, o un ciclo scritto in un file e non
# eseguito ora).
# REGOLA PRUDENTE sul file scritto (giro 5). Un file scritto nel comando (heredoc, cat/tee >,
# echo/printf >, here-string) il cui corpo contiene un'attesa senza tetto e' LANCIATO appena il
# suo nome (basename, anche dietro un glob che lo copre, una variabile assegnata nel comando, un
# nome fra virgolette o con \) compare in un altro punto del comando: argomenti di qualunque
# comando, redirezioni, pipe, sostituzioni, corpi di altri heredoc, qualunque cosa faccia quel
# punto. Restano fuori solo: la scrittura stessa; chmod; ls/stat/wc/test/[ come comando intero
# con l'uscita ne' in pipe ne' in $( ) ne' in una redirezione verso un file; i lanci con tetto:
# perl -e/-we 'alarm N; exec @ARGV' (N > 0 letterale; alarm shift solo se segue un numero > 0) o
# timeout/gtimeout N, davanti al file o a una shell che lo prende come primo argomento. Cat,
# head, tail e un interprete che legge il file NON sono eccezioni. Meglio un rifiuto in piu' (si
# aggiunge un tetto) che una sessione appesa: l'hook ferma chi sbaglia, non chi vuole aggirarlo.
# Ogni corpo che gira come shell e' un'unita' a parte: un apostrofo in `git commit -F - <<EOF`
# non inverte le virgolette del comando esterno. Un heredoc letto da python/node/ruby... si
# ignora se non lancia una shell.
# I commenti (# ...) si tolgono prima di contare le virgolette: un apostrofo in un commento non
# deve invertirle. Le virgolette separano solo dentro l'argomento di un sh/bash/zsh -c scritto
# fuori da altre virgolette (anche -euo pipefail -c, -c --): nohup sh -c 'while ...' si vede;
# pkill -f "tail -n +1 -f", le stringhe nel codice e le prove dell'hook fra virgolette no.
# Un tetto che avvolge un ciclo (timeout, perl alarm N, N > 0) vale solo per quel ciclo: tolto
# quello, il resto del comando si riesamina.
# stdin letto con un builtin: senza until/while/tail nel testo l'hook esce senza processi
[ -n "$JCODE_HOOK_TOOL_NAME" ] && [ "$JCODE_HOOK_TOOL_NAME" != bash ] && exit 0
IFS= read -r -d '' in || true
case "$in" in *until*|*while*|*tail*) ;; *) exit 0 ;; esac

cmd=$(printf %s "$in" | jq -r '.tool_input.command // .command // empty')
[ -n "$cmd" ] || exit 0
case "$cmd" in *WAIT_CAP=off*) exit 0 ;; esac
# File scritto nel comando (heredoc, cat/tee >, echo/printf >, here-string): vedi la REGOLA
# PRUDENTE in testa. Questo awk legge il comando come una shell (virgolette, heredoc, $( ),
# pipe), trova i file scritti, decide quali sono lanciati e stampa: riga 1 = \002 + nomi dei file
# lanciati; poi il comando esterno senza i corpi degli heredoc; poi ogni corpo che gira come shell
# come unita' a parte (\001). Un corpo letto da un interprete non shell (python - <<EOF) si ignora
# se non lancia una shell; un file scritto e non lanciato non si analizza.
read -r -d '' hd_awk <<'AWK' || true
function base(x) { sub(/.*\//,"",x); return x }
# il corpo b gira davvero come shell anche se lo legge un interprete non shell?
function spawns(b, fw) {
  if (b ~ /shell[[:space:]]*(=|:)[[:space:]]*[Tt]rue|os\.(system|popen)|execSync|child_process\.exec[^S]|(^|[^[:alnum:]_])(ba|z)?sh[\047", ]+-[[:alnum:]]*c([^[:alnum:]]|$)/) return 1
  if (fw ~ /^(perl|ruby|php)$/ && b ~ /system|exec|qx|popen|%x|\140/) return 1
  return 0
}
# nm compare in X come nome intero (non dentro un altro nome)
function mentions(X, nm,   l,s,p,pre,post,post2) {
  l=length(nm); if (!l) return 0
  s=1
  while ((p=index(substr(X,s),nm))>0) {
    p=p+s-1
    pre=(p>1)?substr(X,p-1,1):""; post=substr(X,p+l,1); post2=substr(X,p+l+1,1)
    # x.sh non e' dentro catena-x.sh, .x.sh, x.sh2, x.sh-old, x.sh.bak
    if (pre !~ /[A-Za-z0-9_.-]/ && post !~ /[A-Za-z0-9_-]/ && !(post=="." && post2 ~ /[A-Za-z0-9_]/)) return 1
    s=p+1
  }
  return 0
}
# glob -> regex ancorata; ogni carattere strano e' protetto, cosi' la regex e' sempre valida
function g2re(g,   o,i,c,j,cls) {
  o="^"
  for (i=1;i<=length(g);i++) {
    c=substr(g,i,1)
    if (c=="*") o=o "[^/]*"
    else if (c=="?") o=o "[^/]"
    else if (c=="[") {
      j=index(substr(g,i+1),"]")
      cls=(j>1)?substr(g,i+1,j-1):""
      if (cls ~ /^!?[A-Za-z0-9_.,-]+$/) { if (substr(cls,1,1)=="!") cls="^" substr(cls,2); o=o "[" cls "]"; i=i+j }
      else o=o "\\["
    }
    else if (index(".+(){}|^$\\",c)>0) o=o "\\" c
    else o=o c
  }
  return o "$"
}
# la parola e' un glob che copre il nome nm?
function globm(X, nm,   comp) {
  if (X ~ /[[:space:]]/ || X ~ /^-/) return 0
  comp=X; sub(/.*\//,"",comp)
  if (comp !~ /[*?]/ && index(comp,"[")==0) return 0
  return (nm ~ g2re(comp))
}
# $V e ${V...} diventano il valore assegnato nel comando; una variabile ignota resta $V
function expand(s,   it,o,t,k,v) {
  for (it=0; it<3 && index(s,"$"); it++) {
    o=""; t=s
    while (match(t, /\$\{[A-Za-z_][A-Za-z0-9_]*[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*/)) {
      v=substr(t,RSTART,RLENGTH); k=v; sub(/^\$\{?/,"",k); sub(/[^A-Za-z0-9_].*$/,"",k)
      o=o substr(t,1,RSTART-1) ((k in VAL) ? VAL[k] : "$" k)
      t=substr(t,RSTART+RLENGTH)
    }
    s=o t
  }
  return s
}
# nuovo segmento (comando semplice). sb: aperto da $( ` <( >(; pp: dopo una pipe (stessa pipeline)
function openseg(sb, pp) {
  SL[ns]=nw
  if (pp) SPIPN[ns]=1
  ns++; SF[ns]=nw+1; SSUB[ns]=sb; SPIPP[ns]=pp
  if (!pp) pl++
  SPL[ns]=pl
  if (!(pl in PF)) PF[pl]=ns
  PLS[pl]=ns
  nrole=""
}
function emitw(t) { nw++; WD[nw]=t; WS[nw]=ns; WR[nw]=nrole; nrole=""; lastop="" }
# lessico di una shell: parole senza virgolette, segmenti, heredoc con il loro corpo
function lex(   i,c,d,w,hq,brk,dl,dash,cc,k,p,body,line,cmp,b0,cl) {
  nw=0; ns=1; pl=1; SF[1]=1; SSUB[1]=0; SPIPP[1]=0; SPL[1]=1; PF[1]=1; PLS[1]=1
  nrole=""; lastop=""; np=0; nh=0; ostart=1; outer=""; cl=1
  i=1
  while (i<=n) {
    c=substr(S,i,1)
    if (c==" " || c=="\t") { i++; continue }
    if (c=="\n") {
      while (cl<nl && lo[cl+1]-1<i) cl++
      i++
      if (lastop!="|") openseg(0,0)
      if (np>0) {
        b0=lo[cl+1]; k=cl+1
        for (p=1;p<=np;p++) {
          body=""
          while (k<nl) {
            line=LN[k]; cmp=line; if (PDASH[p]) sub(/^\t+/,"",cmp)
            k++
            if (cmp==PDELIM[p]) break
            body=body line "\n"
          }
          HBODY[PDH[p]]=body
        }
        outer=outer substr(S,ostart,b0-ostart); ostart=lo[k]; i=lo[k]; cl=k-1; np=0
      }
      continue
    }
    if (c=="#") { while (i<=n && substr(S,i,1)!="\n") i++; continue }
    if (c==";") { openseg(0,0); lastop=";"; i++; continue }
    if (c=="&") {
      d=substr(S,i+1,1)
      if (d=="&") { openseg(0,0); lastop="&&"; i+=2; continue }
      openseg(0,0); lastop="&"; i++; continue
    }
    if (c=="|") {
      d=substr(S,i+1,1)
      if (d=="|") { openseg(0,0); lastop="||"; i+=2; continue }
      openseg(0,1); lastop="|"; i++; continue
    }
    if (c=="(" || c==")") { openseg(0,0); lastop=c; i++; continue }
    if (c=="`") { openseg(1,0); lastop="`"; i++; continue }
    if (c==">" || c=="<") {
      d=substr(S,i+1,1)
      if (d=="(") { openseg(1,0); lastop=c "("; i+=2; continue }
      if (c==">") {
        if (d==">" || d=="|") i+=2
        else if (d=="&") { i+=2; if (substr(S,i,1) ~ /[0-9-]/) { while (substr(S,i,1) ~ /[0-9-]/) i++; continue } }
        else i++
        nrole="w"; continue
      }
      if (d=="<") {
        i+=2; dash=0; if (substr(S,i,1)=="-") { dash=1; i++ }
        while (substr(S,i,1)==" " || substr(S,i,1)=="\t") i++
        dl=""
        while (i<=n) {
          cc=substr(S,i,1)
          if (cc==" " || cc=="\t" || cc=="\n" || cc==";" || cc=="&" || cc=="|" || cc=="<" || cc==">" || cc=="(" || cc==")") break
          if (cc=="'") { i++; while (i<=n && substr(S,i,1)!="'") { dl=dl substr(S,i,1); i++ } i++; continue }
          if (cc=="\"") { i++; while (i<=n && substr(S,i,1)!="\"") { dl=dl substr(S,i,1); i++ } i++; continue }
          if (cc=="\\") { i++; dl=dl substr(S,i,1); i++; continue }
          dl=dl cc; i++
        }
        if (dl=="") continue
        np++; nh++; PDELIM[np]=dl; PDASH[np]=dash; PDH[np]=nh; HSEG[nh]=ns
        continue
      }
      if (d=="&") { i+=2; while (substr(S,i,1) ~ /[0-9-]/) i++; continue }
      i++; nrole="r"; continue
    }
    w=""; hq=0; brk=0; k=i
    while (i<=n) {
      c=substr(S,i,1)
      if (c==" " || c=="\t" || c=="\n" || c==";" || c=="&" || c=="|" || c=="(" || c==")" || c=="<" || c==">" || c=="`") break
      if (c=="\\") { w=w substr(S,i+1,1); i+=2; continue }
      if (c=="'") { hq=1; i++; while (i<=n && substr(S,i,1)!="'") { w=w substr(S,i,1); i++ } i++; continue }
      if (c=="\"") {
        hq=1; i++
        while (i<=n && substr(S,i,1)!="\"") {
          cc=substr(S,i,1)
          if (cc=="\\") { d=substr(S,i+1,1); if (d=="$" || d=="\"" || d=="\\" || d=="`") { w=w d; i+=2; continue } if (d=="\n") { i+=2; continue } }
          w=w cc; i++
        }
        i++; continue
      }
      if (c=="$") {
        d=substr(S,i+1,1)
        if (d=="(") {
          brk=1; break
        }
        w=w c; i++; continue
      }
      w=w c; i++
    }
    if (brk) { if (w!="" || hq) emitw(w); openseg(1,0); lastop="$("; i+=2; continue }
    if (w=="" && !hq) { if (i==k) i++; continue }
    emitw(w)
  }
  SL[ns]=nw
  outer=outer substr(S,ostart)
}
# indice della parola-comando del segmento s (salta assegnazioni, parole riservate, nohup...)
function cmdidx(s,   w,x,b) {
  for (w=SF[s]; w<=SL[s]; w++) {
    if (WR[w]!="") continue
    x=WD[w]
    if (x ~ /^[A-Za-z_][A-Za-z0-9_]*\+?=/) continue
    b=base(x)
    if (b ~ /^(if|then|else|elif|while|until|do|!|\{|time|command|builtin|nohup|exec|env|sudo|nice|setsid)$/) continue
    return w
  }
  return 0
}
function writes_file(s,   w) {
  for (w=SF[s]; w<=SL[s]; w++) if (WR[w]=="w" && XW[w] !~ /^\/dev\/(null|stderr|stdout)$/) return 1
  return 0
}
# lancio con tetto: perl -e 'alarm N; exec @ARGV' o timeout N davanti al file (tw = la parola che
# lo nomina) o a una shell che lo prende come primo argomento. N letterale e > 0; alarm shift
# vale solo se la parola che segue e' un numero > 0.
function capok(s, tw,   c,b,j,x,k,t,bt,prog,ti,exe,aln,als) {
  c=SC[s]; if (!c) return 0
  b=base(WD[c]); j=c+1
  exe="[[:space:]]*;[[:space:]]*exec[[:space:]]+(\\{[^}]*\\}[[:space:]]*)?@ARGV[[:space:];]*$"
  aln="^[[:space:]]*alarm[[:space:]]*\\(?[[:space:]]*0*[1-9][0-9]*[[:space:]]*\\)?"
  als="^[[:space:]]*alarm[[:space:]]*\\(?[[:space:]]*shift[[:space:]]*\\)?"
  if (b=="perl") {
    while (j<=SL[s]) { x=WD[j]; if (x ~ /^-[wWt]*e$/) break; if (x ~ /^-[wWt]+$/) { j++; continue } return 0 }
    j++; if (j>SL[s]) return 0
    prog=WD[j]; j++
    if (prog ~ (aln exe)) { if (WD[j]=="--") j++ }
    else if (prog ~ (als exe)) { if (WD[j]=="--") j++; if (WD[j] !~ /^0*[1-9][0-9]*$/) return 0; j++ }
    else return 0
  } else if (b ~ /^g?timeout$/) {
    while (j<=SL[s]) { x=WD[j]; if (x ~ /^-[sk]$/) { j+=2; continue } if (x ~ /^-/) { j++; continue } break }
    x=WD[j]
    if (x !~ /^[0-9][0-9.]*[smhd]?$/ || x ~ /^0+(\.0*)?[smhd]?$/) return 0
    j++
  } else return 0
  t=j; if (t>SL[s]) return 0
  ti=t; bt=base(WD[t])
  if (bt ~ /^(sh|bash|zsh|dash|ksh)$/) {
    k=t+1
    while (k<=SL[s]) {
      x=WD[k]
      if (x ~ /^[-+]o$/) { k+=2; continue }
      if (x ~ /^-[A-Za-z]+$/ && x !~ /c/) { k++; continue }
      if (x ~ /^--[a-z-]+$/) { k++; continue }
      break
    }
    ti=k
  }
  return (ti==tw)
}
# il file scritto (voce e) viene lanciato? 1 = si', o il nome compare in un punto che non e' un'eccezione
function launched(e,   nm,pid,s,w,X,c,cb,cnt,tw,istee,h,p,e2,own) {
  nm=EN[e]; pid=EPL[e]
  if (hasUS) return 1
  for (s=1;s<=ns;s++) {
    if (SA[s]) continue
    c=SC[s]; cb=c?base(WD[c]):""; istee=(cb=="tee")
    cnt=0; tw=0
    for (w=SF[s]; w<=SL[s]; w++) {
      if (WR[w]=="w") continue
      if (istee && w>c && WD[w] !~ /^-/) continue
      X=XW[w]
      if (mentions(X,nm) || globm(X,nm)) { cnt++; tw=w }
    }
    if (!cnt) continue
    # eccezioni, elenco chiuso: chmod; ls/stat/wc/test come comando intero con l'uscita ferma
    # li'; i lanci con tetto
    if (cb=="chmod") continue
    if (cb ~ /^(ls|stat|wc|test|\[|\[\[)$/ && !SSUB[s] && !SPIPN[s] && !writes_file(s)) continue
    if (cnt==1 && capok(s,tw)) continue
    return 1
  }
  # il corpo di un altro heredoc (qualunque cosa faccia) che nomina il file
  for (h=1;h<=nh;h++) {
    p=SPL[HSEG[h]]; own=0
    for (e2=1;e2<=ne;e2++) if (EPL[e2]==p && EN[e2]==nm) own=1
    if (!own && mentions(HN[h],nm)) return 1
  }
  return 0
}
function addt(x, raw, pid,   m,a,i,b) {
  m=split(x,a,/[[:space:]]+/)
  for (i=1;i<=m;i++) {
    if (a[i]=="" || a[i]=="-" || a[i] ~ /^\/dev\//) continue
    b=base(a[i]); if (b=="") continue
    ne++; EN[ne]=b; EF[ne]=raw; EPL[ne]=pid; ISENT[pid]=1
  }
}
function process(   s,w,k,v,pid,e,h,c,cb,fc,fw,t,lf) {
  lex()
  for (w=1;w<=nw;w++) {
    if (WR[w]=="" && WD[w] ~ /^[A-Za-z_][A-Za-z0-9_]*\+?=/) {
      k=WD[w]; v=k; sub(/\+?=.*/,"",k); sub(/^[^=]*=/,"",v)
      # G="$G" (awk -v G="$G") non cambia il valore di G
      if (v ~ ("\\$\\{?" k "([^A-Za-z0-9_]|$)")) continue
      VAL[k]=((k in VAL)?VAL[k] " ":"") v
    }
  }
  for (w=1;w<=nw;w++) { XW[w]=expand(WD[w]); if (WD[w] ~ /\$\{?_\}?([^A-Za-z0-9_]|$)/) hasUS=1 }
  for (s=1;s<=ns;s++) {
    c=cmdidx(s); SC[s]=c; SA[s]=0
    if (!c) { for (w=SF[s];w<=SL[s];w++) if (WR[w]=="" && WD[w] ~ /^[A-Za-z_][A-Za-z0-9_]*\+?=/) SA[s]=1 }
    else if (base(WD[c]) ~ /^(export|local|declare|readonly|typeset)$/) SA[s]=1
  }
  # file scritti: pipeline che comincia con cat/tee/echo/printf e scrive con > >> o tee
  ne=0
  for (pid=1;pid<=pl;pid++) {
    if (!(pid in PF)) continue
    fc=0; for (s=PF[pid];s<=PLS[pid];s++) if (SC[s]) { fc=SC[s]; break }
    if (fc && base(WD[fc]) ~ /^(cat|tee|echo|printf|print)$/) TXTP[pid]=1
  }
  for (pid=1;pid<=pl;pid++) {
    if (!TXTP[pid]) continue
    for (s=PF[pid];s<=PLS[pid];s++) {
      cb=SC[s]?base(WD[SC[s]]):""
      for (w=SF[s];w<=SL[s];w++) {
        if (WR[w]=="w") addt(XW[w],WD[w],pid)
        else if (cb=="tee" && w>SC[s] && WR[w]=="" && WD[w] !~ /^-/) addt(XW[w],WD[w],pid)
      }
    }
  }
  for (h=1;h<=nh;h++) { HN[h]=HBODY[h]; gsub(/['"\\]/,"",HN[h]) }
  # echo/printf/cat che passano per una pipe verso una shell: il testo e' un'attesa lanciata
  for (pid=1;pid<=pl;pid++) {
    if (!TXTP[pid]) continue
    for (s=PF[pid];s<=PLS[pid];s++) if (SPIPP[s] && SC[s] && base(WD[SC[s]]) ~ /^(sh|bash|zsh|dash|ksh)$/) { ISENT[pid]=1; PLA[pid]=1 }
  }
  lf=""
  for (e=1;e<=ne;e++) if (launched(e)) { PLA[EPL[e]]=1; if (index(" " lf " "," " EF[e] " ")==0) lf=lf (lf==""?"":" ") EF[e] }
  print "\002" lf
  printf "%s", outer
  if (substr(outer,length(outer))!="\n") print ""
  for (h=1;h<=nh;h++) {
    pid=SPL[HSEG[h]]
    if (pid in ISENT) { if (!PLA[pid]) continue }
    else {
      c=SC[HSEG[h]]; fw=c?base(WD[c]):""
      if (fw ~ /^(python[0-9.]*|node|nodejs|bun|deno|swift|ruby|perl|php)$/ && !spawns(HBODY[h],fw)) continue
    }
    print "\001"; printf "%s", HBODY[h]
  }
  # echo/printf/here-string: il testo scritto e' nelle parole della pipeline
  for (pid=1;pid<=pl;pid++) if ((pid in ISENT) && PLA[pid]) {
    t=""
    for (s=PF[pid];s<=PLS[pid];s++) for (w=SF[s];w<=SL[s];w++) t=t WD[w] "\n"
    gsub(/['"]/," ",t); gsub(/#/," ",t)
    print "\001"; printf "%s", t
  }
}
# un solo record (RS=\001): niente concatenazioni riga per riga
BEGIN { RS="\001" }
{ S = $0 "\n" }
END {
  n=length(S)
  nl=split(S,LN,"\n"); lo[1]=1
  for (k=1;k<=nl;k++) lo[k+1]=lo[k]+length(LN[k])+1
  process()
}
AWK
case "$cmd" in
  *'<<'*|*'>'*|*'|'*|*tee*)
    if out=$(printf %s "$cmd" | awk "$hd_awk") && [ -n "$out" ]; then
      lf=${out%%$'\n'*}; lf=${lf#$'\002'}; cmd=${out#*$'\n'}
    fi ;;
esac
# commenti fuori: un apostrofo in `# aspetta l'indice` inverte il conteggio delle virgolette.
# Passaggio che le conosce: # inizia un commento solo a inizio parola e fuori da ogni virgoletta
# ($'...' ha il suo \' di escape); il commento finisce con la riga.
cmd=$(printf %s "$cmd" | awk '{
  s=$0; n=length(s); out=""
  if (s=="\001") q=0
  for (i=1;i<=n;i++) {
    c=substr(s,i,1)
    if (q==0) {
      if (c=="\\") { out=out c substr(s,i+1,1); i++; continue }
      if (c=="#" && (i==1 || substr(s,i-1,1) ~ /[[:space:];&|()]/)) break
      if (c=="\047") q=(substr(s,i-1,1)=="$")?3:1; else if (c=="\"") q=2
    } else if (q==1) { if (c=="\047") q=0 }
    else if (q==3) { if (c=="\\") { out=out c substr(s,i+1,1); i++; continue }; if (c=="\047") q=0 }
    else { if (c=="\\") { out=out c substr(s,i+1,1); i++; continue }; if (c=="\"") q=0 }
    out=out c
  }
  printf "%s%s", (NR>1 ? "\n" : ""), out }')
# una riga sola: until e do stanno spesso su righe diverse
flat=$(printf %s "$cmd" | tr '\n' ';')
# opzioni fra sh/bash/zsh e -c: -x, --login, -o pipefail, +o history, -euo pipefail
shopts='(([-+][[:alnum:]]*[oO][[:space:]]+[[:alnum:]_]+|-[-[:alnum:]]+)[[:space:]]+)*'
# l'argomento di -c: -c 'testo' oppure -c -- 'testo'
shc="${shopts}-[[:alnum:]]*c[[:space:]]+(--[[:space:]]+)?"
# la virgoletta che apre l'argomento di sh/bash/zsh -c diventa un separatore, solo se quel
# `sh -c` e' scritto fuori da ogni altra virgoletta (una prova dell'hook fra virgolette non conta)
quotesep() { awk -v shre="(^|[^[:alnum:]_])(ba|z)?sh[[:space:]]+${shc}\$" '{
  s=$0; n=length(s); q=0; out=""
  for (i=1;i<=n;i++) {
    c=substr(s,i,1)
    if (c=="\001") { q=0; out=out ";"; continue }
    if (q==0) {
      if (c=="\\") { out=out c substr(s,i+1,1); i++; continue }
      if (c=="\047" || c=="\"") {
        if (out ~ shre) out=out ";"; else out=out c
        q=(c=="\047")?1:2; continue
      }
    } else if (q==1) { if (c=="\047") q=0 }
    else { if (c=="\\") { out=out c substr(s,i+1,1); i++; continue }; if (c=="\"") q=0 }
    out=out c
  }
  print out }'; }

sep='(^|[;&|({!`[:space:]])'
# cosa c'e' di attesa nel testo $1 (gia' passato da quotesep): vuoto se niente
detect() {
  # `while read` scorre un input che finisce: non e' un'attesa
  local loops
  loops=$(printf %s "$1" | sed -E 's/(while|until)[[:space:]]+(IFS=[^[:space:]]*[[:space:]]+)?read([[:space:]]|$)/READLOOP /g')
  if printf %s "$loops" | grep -qE "${sep}(until|while)[[:space:]].*[;[:space:]]do([;[:space:]]|$)" &&
     printf %s "$1" | grep -qE '(^|[^[:alnum:]_.])sleep[[:space:]]'; then
    echo 'un ciclo until/while con sleep'
  # anche con opzioni prima di -f: tail -n 50 -f
  elif printf %s "$1" | grep -qE "${sep}tail([[:space:]]+-[^[:space:];&|()]+([[:space:]]+[0-9+]+)?)*[[:space:]]+(-[[:alnum:]]*[fF]|--follow)"; then
    echo 'un tail -f'
  fi
}
what=$(detect "$(printf %s "$flat" | quotesep)")
[ -n "$what" ] || exit 0

cmp='-(ge|gt|le|lt|eq)[[:space:]]|\(\([^)]*[<>]=?[[:space:]]*[0-9]'
printf %s "$flat" | grep -qE '(^|[^[:alnum:]_])SECONDS([^[:alnum:]_]|$)' && exit 0
printf %s "$flat" | grep -qE 'date[[:space:]]+\+%s|EPOCHSECONDS' && printf %s "$flat" | grep -qE -- "$cmp" && exit 0
printf %s "$flat" | grep -qE '(^|[^[:alnum:]_-])seq[[:space:]]+[0-9$]' && exit 0
# timeout copre solo il comando che avvolge: dentro la condizione (until timeout 5 nc ...)
# limita la sonda, non il ciclo. Vale quindi solo davanti a sh/bash/zsh -c '<attesa>' o al tail
# N letterale e > 0 (timeout 0 non limita niente)
to="${sep}g?timeout[[:space:]]+(-[^[:space:]]+[[:space:]]+([[:alnum:]]+[[:space:]]+)?)*(0*[1-9][0-9]*(\.[0-9]*)?|0+\.[0-9]*[1-9][0-9]*)[smhd]?[[:space:]]+"
# perl -e 'alarm N; exec @ARGV' <comando> e' il timeout del Mac (non c'e' timeout); anche
# alarm(N), il programma fra virgolette doppie e exec { $ARGV[0] } @ARGV. N letterale e > 0;
# alarm shift vale solo se subito dopo (salvo --) c'e' un numero > 0.
pexe='[[:space:]]*;[[:space:]]*exec[[:space:]]+(\{[^}]*\}[[:space:]]*)?@ARGV[[:space:];]*'
paln='alarm[[:space:]]*\(?[[:space:]]*0*[1-9][0-9]*[[:space:]]*\)?'
pals='alarm[[:space:]]*\(?[[:space:]]*shift[[:space:]]*\)?'
ppre="${sep}perl[[:space:]]+(-[wWt]+[[:space:]]+)*-[wWt]*e[[:space:]]+"
pa_lit="${ppre}['\"][[:space:]]*${paln}${pexe}['\"][[:space:]]+(--[[:space:]]+)?"
pa_shift="${ppre}['\"][[:space:]]*${pals}${pexe}['\"][[:space:]]+(--[[:space:]]+)?0*[1-9][0-9]*[[:space:]]+"
wr="(${to}|${pa_lit}|${pa_shift})"
# il tetto vale per il ciclo (o il tail -f) che avvolge: tolto quello, il resto del comando si
# riesamina (perl ... sh -c 'while...' & until grep -q X log; do sleep 5; done resta senza tetto)
kw='(until|while|tail)[[:space:]]'
flat2=$(printf %s "$flat" | sed -E "s#${wr}([^[:space:]]*/)?(ba|z)?sh[[:space:]]+${shc}('[^']*${kw}[^']*'|\"[^\"]*${kw}[^\"]*\")#;#g; s#${wr}tail[[:space:]]#;#g")
what=$(detect "$(printf %s "$flat2" | quotesep)")
[ -n "$what" ] || exit 0
# contatore: n=$((n+1)), ((n++)), ((n+=1)) o let n++, piu' un confronto
inc='[[:alpha:]_][[:alnum:]_]*=\$\(\([[:space:]]*\$?[[:alpha:]_][[:alnum:]_]*[[:space:]]*\+[[:space:]]*[0-9]|\(\([[:space:]]*[[:alpha:]_][[:alnum:]_]*[[:space:]]*(\+\+|\+=)|let[[:space:]]+[[:alpha:]_]'
printf %s "$flat" | grep -qE "$inc" && printf %s "$flat" | grep -qE -- "$cmp" && exit 0

echo "Attesa senza tetto: questo comando contiene $what e niente che lo faccia finire da solo." >&2
printf %s "$flat" | grep -qE "${sep}g?timeout[[:space:]]" &&
  echo "Il timeout qui copre solo il comando che avvolge, non l'attesa; e sul Mac timeout non esiste (exit 127 a ogni giro, il ciclo non finisce mai): usa \$SECONDS come sotto." >&2
if [ -n "$lf" ]; then
  f1=${lf%% *}
  echo "Il file $f1 contiene l'attesa e il comando lo lancia o ne cita il nome: ogni punto che lo nomina conta come un lancio (esclusi chmod, ls/stat/wc/test da soli e i lanci con tetto)." >&2
  echo "Due modi: un tetto nel ciclo del file, oppure lancialo cosi':  perl -e 'alarm 600; exec @ARGV' bash $f1" >&2
fi
cat >&2 <<'EOF'
Il 25/10 15 attese su 25 delle sessioni non avevano tetto (una aspettava il PC da 17 h) e
nessuno le chiude: un comando oltre i 120 s passa in background da solo. Mettigli un tetto:
  s=$SECONDS; until <condizione> || [ $((SECONDS-s)) -gt 3600 ]; do sleep 30; done
  end=$(( $(date +%s) + 3600 )); until <condizione> || [ $(date +%s) -ge $end ]; do sleep 30; done
  while <condizione> && [ $((SECONDS-s)) -lt 3600 ]; do sleep 30; done     (con s=$SECONDS prima)
`timeout` sul Mac non c'e'. Per seguire un log usa lo strumento Monitor (ha un tetto), non tail -f.
Se l'attesa deve restare aperta davvero: WAIT_CAP=off davanti al comando.
EOF
exit 2
