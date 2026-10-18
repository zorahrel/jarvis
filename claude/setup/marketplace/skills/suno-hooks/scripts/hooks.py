#!/usr/bin/env python3
"""hooks.py — reverse-engineer a generated song take into a reusable prompt.

Answers one question: *what did the model sing that nobody wrote?*
Those improvised bits are usually the parts you love (chants, ad-libs, doubled
words) and they disappear on the next generation, because they exist nowhere.

  python3 hooks.py TAKE.mp3 --lyrics written.txt --lang es
  python3 hooks.py TAKE.mp3 --stem vocals.wav --lang es --out report.md

What it does
  1. isolates the vocal (demucs, cached) — every measurement is on the stem, never the mix
  2. transcribes it word by word (whisper.cpp, --ml 1)
  3. diffs SUNG against WRITTEN: what is missing from the text is what the model invented
  4. finds fast re-attacks (the o-o-o-otra artifact) and splits them in two:
       HOOK     the repeated thing is a whole WORD repeated (no, no, no) -> write it down
       ARTIFACT the repetition is sub-lexical, one word chopped -> ban it
Requires: demucs, whisper-cli (whisper.cpp) + a ggml model, librosa, numpy, scipy.
"""
import argparse,glob,json,os,re,subprocess,sys,unicodedata
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))

CACHE=os.environ.get('HOOKS_CACHE','/tmp/suno_hooks')

def norm(w):
    w=unicodedata.normalize('NFD',w.lower().strip())
    return ''.join(c for c in w if c.isalnum())

def vocal_stem(audio,given=None):
    if given: return given
    base=os.path.splitext(os.path.basename(audio))[0]
    out=os.path.join(CACHE,'htdemucs',base,'vocals.wav')
    if not os.path.exists(out):
        dev=os.environ.get('DEMUCS_DEVICE','mps' if sys.platform=='darwin' else 'cpu')
        exe=os.environ.get('DEMUCS','demucs')
        print(f'  separo la voce ({dev})…',file=sys.stderr)
        subprocess.run([exe,'-n','htdemucs','-d',dev,'--two-stems=vocals','-o',CACHE,audio],
                       capture_output=True,timeout=1800)
    if not os.path.exists(out): sys.exit(f'stem non prodotto: {out}')
    return out

def whisper_words(stem,lang,model):
    if not model:
        for p in ('~/whisper-models/ggml-large-v3.bin','~/models/whisper/ggml-large-v3-turbo.bin',
                  '~/whisper-models/ggml-small.bin'):
            p=os.path.expanduser(p)
            if os.path.exists(p): model=p; break
    if not model: sys.exit('nessun modello whisper: passa --model /path/ggml-*.bin')
    of=os.path.join(CACHE,os.path.basename(stem)+'.'+os.path.basename(os.path.dirname(stem))[:8])
    if not os.path.exists(of+'.json'):
        os.makedirs(CACHE,exist_ok=True)
        print('  trascrivo…',file=sys.stderr)
        subprocess.run(['whisper-cli','-m',model,'-l',lang,'-ml','1','--output-json','-of',of,stem],
                       capture_output=True,timeout=3600)
    d=json.load(open(of+'.json'))
    raw=[(x['offsets']['from']/1000.0,x['text']) for x in d['transcription'] if x['text'].strip()]
    # whisper con -ml 1 spezza dentro le parole ("n","ub","la"): i pezzi senza spazio
    # iniziale sono continuazioni, li riattacco o l'allineamento vede differenze finte
    out=[]
    for t,w in raw:
        if out and not w.startswith(' '): out[-1][1]+=w
        else: out.append([t,w.strip()])
    return [(t,w) for t,w in out if w.strip(' ,.!?¡¿')]

def lines(words,gap=0.55):
    out=[];cur=[];last=None
    for t,w in words:
        if last is not None and t-last>gap and cur:
            out.append((cur[0][0],''.join(x for _,x in cur).strip())); cur=[]
        cur.append((t,w)); last=t
    if cur: out.append((cur[0][0],''.join(x for _,x in cur).strip()))
    return [(t,l) for t,l in out if l]

def written_tokens(text):
    text=re.sub(r'\[[^\]]*\]','',text or '')          # via i tag di sezione
    return [norm(w) for w in re.findall(r"[\w'áéíóúñü]+",text,re.I) if norm(w)]

def toks(s):
    return [norm(w) for w in re.findall(r"[\w\'áéíóúñü]+",s or '') if norm(w)]

def written_lines(text):
    text=re.sub(r'\[[^\]]*\]','',text or '')          # via i tag di sezione
    return [l.strip() for l in text.splitlines() if toks(l)]

def runs(tk):
    """ripetizioni consecutive della stessa parola: [(parola, quante volte), ...]"""
    out=[];i=0
    while i<len(tk):
        j=i
        while j+1<len(tk) and tk[j+1]==tk[i]: j+=1
        if j-i+1>=2: out.append((tk[i],j-i+1))
        i=j+1
    return out

def improvised(words,text):
    """Allineo TUTTO il cantato contro TUTTO lo scritto (SequenceMatcher sui token) e
    tengo i pezzi che stanno solo nel cantato: quelli il modello se li e' inventati.
    Riga per riga non funziona — whisper spezza le frasi dove il cantante respira."""
    from difflib import SequenceMatcher
    W=toks(re.sub(r'\[[^\]]*\]','',text or ''))
    S=[(t,norm(w)) for t,w in words if norm(w)]
    st=[w for _,w in S]
    out=[]
    for tag,i1,i2,j1,j2 in SequenceMatcher(None,W,st,autojunk=False).get_opcodes():
        if tag in ('insert','replace') and j2-j1>=2:
            seg=st[j1:j2]; t0=S[j1][0]
            rr=[(w,n) for w,n in runs(seg) if n>=3]
            out.append({'t':t0,'testo':' '.join(seg),'n':len(seg),
                        'ripete':', '.join(f'«{w}»×{n}' for w,n in rr)})
    out=[o for o in out if o['n']>=3 or o['ripete']]
    m=[]
    for o in out:                                   # fondo i pezzi attaccati
        if m and o['t']-m[-1]['t']<1.2:
            m[-1]['testo']+=' '+o['testo']; m[-1]['n']+=o['n']
            m[-1]['ripete']=(m[-1]['ripete']+' '+o['ripete']).strip(); continue
        m.append(o)
    return m

def classify(events,words):
    """HOOK se nella finestra dell'evento la stessa PAROLA intera torna >=3 volte
    (no, no, no) — cioe' whisper vede la ripetizione. ARTIFACT se non la vede:
    la ripetizione e' dentro una parola sola, ed e' proprio il difetto."""
    out=[]
    for e in events:
        a=e['t']-0.35; b=e['t']+max(e.get('dur',0.3),0.3)+0.7
        w=[norm(x) for t,x in words if a<=t<=b and norm(x)]
        top=max(((w.count(x),x) for x in set(w)),default=(0,''))
        e=dict(e); e['parole']=' '.join(w[:12]); e['ripetuta']=top[1]; e['volte']=top[0]
        e['tipo']='hook' if top[0]>=3 else 'artefatto'
        out.append(e)
    return out

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('audio'); ap.add_argument('--lyrics'); ap.add_argument('--stem')
    ap.add_argument('--lang',default='es'); ap.add_argument('--model'); ap.add_argument('--out')
    ap.add_argument('--gap',type=float,default=0.55)
    a=ap.parse_args()
    os.makedirs(CACHE,exist_ok=True)
    stem=vocal_stem(a.audio,a.stem)
    words=whisper_words(stem,a.lang,a.model)
    ln=lines(words,a.gap)
    txt=''
    if a.lyrics: txt=sys.stdin.read() if a.lyrics=='-' else open(a.lyrics).read()
    imp=improvised(words,txt) if txt.strip() else []
    from stutter import analyze
    ev=classify(analyze(stem)['lista'],words)
    hook=[e for e in ev if e['tipo']=='hook']; art=[e for e in ev if e['tipo']=='artefatto']

    o=[]
    o.append(f'# {os.path.basename(a.audio)} — cosa canta davvero\n')
    o.append(f'{len(words)} parole · {len(ln)} righe · {len(ev)} ripetizioni rapide '
             f'({len(hook)} sono hook, {len(art)} sono difetti)\n')
    o.append('## Trascrizione (voce isolata)\n```')
    for t,l in ln: o.append(f'{int(t//60)}:{t%60:05.2f}  {l}')
    o.append('```\n')
    if txt.strip():
        o.append('## Improvvisato dal modello (non era nel testo)\n')
        if imp:
            o.append('| tempo | parole | in piu\' rispetto al testo | ripetizioni volute |\n|---|---|---|---|')
            for e in imp:
                o.append(f"| {int(e['t']//60)}:{e['t']%60:05.2f} | {e['n']} | {e['testo'][:78]} | {e['ripete'] or '—'} |")
        else: o.append('_niente: il modello ha cantato quello che c\'era scritto._')
        o.append('')
    o.append('## Ripetizioni rapide, divise in due\n')
    o.append('| tempo | ×  | ogni | tipo | parola ripetuta | contesto |\n|---|---|---|---|---|---|')
    for e in ev:
        o.append(f"| {e['t']:.2f}s | {e['ripetizioni']} | {e['ioi_ms']} ms | "
                 f"**{e['tipo']}** | {e['ripetuta'] or '—'} ×{e['volte']} | {e['parole'][:60]} |")
    o.append('\n**Da scrivere nel testo** (sono la firma del pezzo): ' +
             (', '.join(f"{e['t']:.1f}s «{e['ripetuta']}»×{e['volte']}" for e in hook) or 'nessuna'))
    o.append('\n**Da vietare** (tag di sezione + Exclude): ' +
             (', '.join(f"{e['t']:.1f}s" for e in art) or 'nessuna'))
    r='\n'.join(o)
    if a.out: open(a.out,'w').write(r); print(f'scritto {a.out}')
    else: print(r)

if __name__=='__main__': main()
