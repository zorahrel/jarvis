#!/usr/bin/env python3
"""Scatti vocali (o-o-o-otra vez). DUE rilevatori indipendenti, poi unione.

A) RI-ATTACCHI VELOCI: >=3 ripetizioni dello stesso timbro. Soglia sulla VELOCITA', perche'
   e' li' che sta la differenza: una sillaba cantata sta a 3-6 al secondo, uno scatto sopra i 6.
   -> 3 ripetizioni valgono solo se sotto i 170 ms (>=6 Hz); da 4 in su si accettano fino a 260 ms.
B) MODULAZIONE VELOCE: inviluppo che pulsa fra 8 e 25 Hz (sopra il ritmo sillabico).
   NB: la correlazione sulla forma d'onda grezza NON serve (misurata: mai sopra 0.74) perche'
   Suno risintetizza la sillaba invece di incollarla: la copia e' timbrica, non campionaria.
Da usare SOLO sullo stem vocale: sul mix intero conta gli hi-hat.
"""
import sys, json, numpy as np, librosa, scipy.signal as sig

SR=22050; HOP=128
def _prep(path):
    y,_=librosa.load(path,sr=SR,mono=True)
    ny=SR/2
    sos=sig.butter(4,[250/ny,min(5000,ny*0.99)/ny],'band',output='sos')
    return y,np.nan_to_num(sig.sosfiltfilt(sos,y).astype(np.float32))

def _reattacks(v):
    oe=librosa.onset.onset_strength(y=v,sr=SR,hop_length=HOP)
    on=librosa.onset.onset_detect(onset_envelope=oe,sr=SR,hop_length=HOP,units='time',
                                  backtrack=False,delta=0.12)          # v1: 0.25, troppo sordo
    M=librosa.feature.mfcc(y=v,sr=SR,n_mfcc=20,hop_length=HOP)[1:]
    M/=(np.linalg.norm(M,axis=0,keepdims=True)+1e-9)
    def sim(t1,t2,ms=60):
        a=int(t1*SR/HOP); b=int(t2*SR/HOP); n=int(ms/1000*SR/HOP)
        if b+n>M.shape[1] or n<3: return 0.0
        return float((M[:,a:a+n]*M[:,b:b+n]).sum()/n)
    ev=[]; i=0
    while i<len(on)-1:
        run=[on[i]]; j=i
        while j+1<len(on):
            ioi=on[j+1]-on[j]
            if not (0.055<=ioi<=0.260): break
            s=sim(on[j],on[j+1])
            if s<0.90: break
            if len(run)>1:
                prev=run[-1]-run[-2]
                if abs(ioi-prev)/prev>0.40: break
            run.append(on[j+1]); j+=1
        ok = len(run)>=4 or (len(run)==3 and np.median(np.diff(run))<=0.170)
        if ok:
            ev.append({'t':round(float(run[0]),2),'ripetizioni':len(run),
                       'ioi_ms':int(np.median(np.diff(run))*1000),
                       'dur':round(float(run[-1]-run[0]),2),'via':'A'})
            i=j+1
        else: i+=1
    return ev

def _modulation(v):
    env=librosa.feature.rms(y=v,frame_length=512,hop_length=HOP)[0]
    fs=SR/HOP                                        # ~172 Hz
    env=env/(np.percentile(env,95)+1e-9)
    win=int(0.35*fs); step=int(0.08*fs); ev=[]
    for a in range(0,len(env)-win,step):
        w=env[a:a+win]
        if w.mean()<0.18: continue                    # silenzio: niente voce
        x=w-w.mean()
        sp=np.abs(np.fft.rfft(x*np.hanning(len(x))))
        fr=np.fft.rfftfreq(len(x),1/fs)
        band=(fr>=8)&(fr<=25)
        if not band.any(): continue
        pk=sp[band].max(); tot=sp[(fr>1)].sum()+1e-9
        if pk/tot>0.38 and pk>1.1:                    # pulsazione dominante e forte
            f=float(fr[band][np.argmax(sp[band])])
            ev.append({'t':round(a/fs,2),'ripetizioni':max(2,int(round(f*0.35))),
                       'ioi_ms':int(1000/f),'dur':0.35,'via':'B'})
    out=[]
    for e in ev:                                      # fondo le finestre contigue
        if out and e['t']-out[-1]['t']<=0.45:
            out[-1]['dur']=round(e['t']+0.35-out[-1]['t'],2); continue
        out.append(e)
    return out

def analyze(path):
    y,v=_prep(path)
    A=_reattacks(v); B=_modulation(v)
    ev=A[:]
    for b in B:                                       # unione: B aggiunge solo cio' che A non ha visto
        if not any(abs(b['t']-a['t'])<0.5 for a in A): ev.append(b)
    ev.sort(key=lambda e:e['t'])
    dur=len(y)/SR
    return {'file':path.split('/')[-2] if path.endswith('vocals.wav') else path.split('/')[-1],
            'durata':round(dur,1),'eventi':len(ev),'solo_A':len(A),'solo_B':len(ev)-len(A),
            'per_minuto':round(len(ev)/(dur/60),1),'lista':ev[:60]}

if __name__=='__main__':
    out=[analyze(p) for p in sys.argv[1:]]
    for r in sorted(out,key=lambda r:r['per_minuto']):
        print(f"{r['file'][:38]:<40} {r['eventi']:>3} scatti ({r['per_minuto']:>5}/min)  [ri-attacchi {r['solo_A']}, modulazione +{r['solo_B']}]")
        for e in r['lista'][:8]:
            print(f"      {e['t']:>7.2f}s  x{e['ripetizioni']}  ogni {e['ioi_ms']} ms   [{e['via']}]")
    json.dump(out,open('/tmp/stutter.json','w'))
