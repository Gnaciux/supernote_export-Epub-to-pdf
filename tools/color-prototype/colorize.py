"""Prototype of the colour-restoration algorithm (to be ported to Kotlin)."""
import sys, glob, os, zipfile, io, time
import numpy as np
from PIL import Image

F = 4          # page downscale for detection
WHITE = 232    # non-white threshold
def lum(rgb):  # rgb uint8 HxWx3 -> float gray (same formula as the writer)
    return (rgb[...,0]*299 + rgb[...,1]*587 + rgb[...,2]*114)/1000.0

def load_epub_images(path):
    out=[]
    with zipfile.ZipFile(path) as z:
        for n in z.namelist():
            if not n.lower().endswith(('.jpg','.jpeg','.png','.gif','.webp')): continue
            try: im=Image.open(io.BytesIO(z.read(n)))
            except Exception: continue
            if min(im.size)<64: continue
            if im.mode in ('RGBA','LA','P'):
                im=im.convert('RGBA'); bg=Image.new('RGBA',im.size,(255,255,255,255)); bg.alpha_composite(im); im=bg
            im=im.convert('RGB')
            sm=np.asarray(im.resize((64,64)),dtype=np.int32)
            chroma=(sm.max(-1)-sm.min(-1))>25
            if chroma.mean()<0.03: continue           # grey image: nothing to restore
            a=np.asarray(im); g=lum(a.astype(np.float32))
            ys,xs=np.where(g<WHITE)
            if len(xs)==0: continue
            bb=(xs.min(),ys.min(),xs.max()+1,ys.max()+1)
            out.append(dict(name=n,rgb=a,gray=g,bbox=bb,small=resize_gray(g,max(1,g.shape[1]//2),max(1,g.shape[0]//2))))
    return out

def components(mask):
    """8-connected components bboxes (simple BFS on low-res mask)."""
    h,w=mask.shape; seen=np.zeros_like(mask,bool); boxes=[]
    for y in range(h):
        for x in range(w):
            if mask[y,x] and not seen[y,x]:
                st=[(y,x)]; seen[y,x]=True; x0=x1=x; y0=y1=y; n=0
                while st:
                    cy,cx=st.pop(); n+=1
                    x0=min(x0,cx);x1=max(x1,cx);y0=min(y0,cy);y1=max(y1,cy)
                    for dy in (-1,0,1):
                        for dx in (-1,0,1):
                            ny,nx=cy+dy,cx+dx
                            if 0<=ny<h and 0<=nx<w and mask[ny,nx] and not seen[ny,nx]:
                                seen[ny,nx]=True; st.append((ny,nx))
                boxes.append((x0,y0,x1+1,y1+1,n))
    return boxes

def dilate(m,r):
    out=m.copy()
    for dy in range(-r,r+1):
        for dx in range(-r,r+1):
            out|=np.roll(np.roll(m,dy,0),dx,1)
    return out

def resize_gray(g,w,h):
    return np.asarray(Image.fromarray(g.astype(np.float32)).resize((max(1,w),max(1,h)),Image.BILINEAR))

def ncc(a,b):
    a=a-a.mean(); b=b-b.mean(); d=np.sqrt((a*a).sum()*(b*b).sum())
    return float((a*b).sum()/d) if d>0 else 0.0

def find_matches(page_gray, imgs, log):
    H,W=page_gray.shape
    low=resize_gray(page_gray,W//F,H//F); h,w=low.shape
    mask=low<WHITE
    if mask.mean()<0.002: return []
    cands=[]
    ys,xs=np.where(mask); cands.append((xs.min(),ys.min(),xs.max()+1,ys.max()+1))
    for (x0,y0,x1,y1,n) in components(dilate(mask,3)):
        if (x1-x0)*(y1-y0) >= 0.02*w*h: cands.append((max(0,x0-3),max(0,y0-3),min(w,x1-3+3),min(h,y1)))
    res=[]
    for c in set(cands):
        cw,ch=c[2]-c[0],c[3]-c[1]
        if cw<8 or ch<8: continue
        best=None
        for im in imgs:
            bx0,by0,bx1,by1=im['bbox']; bw,bh=bx1-bx0,by1-by0
            if abs((cw/ch)/(bw/bh)-1)>0.15: continue
            t=resize_gray(im['gray'][by0:by1,bx0:bx1],cw,ch)
            s=ncc(t,low[c[1]:c[3],c[0]:c[2]])
            if best is None or s>best[0]: best=(s,im)
        if best and best[0]>=0.7:
            res.append((best[0],c,best[1]))
    # keep best per image, drop overlapping weaker ones
    res.sort(key=lambda r:-r[0]); kept=[]
    for r in res:
        c=r[1]
        if any(not (c[2]<=k[1][0] or c[0]>=k[1][2] or c[3]<=k[1][1] or c[1]>=k[1][3]) for k in kept): continue
        kept.append(r)
    return kept

def place(match, page_gray):
    s,c,im=match
    bx0,by0,bx1,by1=im['bbox']
    H,W=page_gray.shape
    X0,Y0,X1,Y1=c[0]*F,c[1]*F,c[2]*F,c[3]*F
    reg=page_gray[max(0,Y0-2*F):min(H,Y1+2*F), max(0,X0-2*F):min(W,X1+2*F)]
    ys,xs=np.where(reg<WHITE)
    ox,oy=max(0,X0-2*F),max(0,Y0-2*F)
    X0,Y0,X1,Y1=xs.min()+ox,ys.min()+oy,xs.max()+1+ox,ys.max()+1+oy
    sx=(X1-X0)/(bx1-bx0); sy=(Y1-Y0)/(by1-by0)
    low=resize_gray(page_gray,W//F,H//F)
    lo,hi=min(sx,sy)*0.96,max(sx,sy)*1.04
    scales=[lo+(hi-lo)*k/16 for k in range(17)]
    def at(sc,ax,ay):
        x = X0-bx0*sc if ax=='l' else (X1-bx1*sc if ax=='r' else (X0+X1)/2-(bx0+bx1)/2*sc)
        y = Y0-by0*sc if ay=='t' else (Y1-by1*sc if ay=='b' else (Y0+Y1)/2-(by0+by1)/2*sc)
        return dict(x=x,y=y,sx=sc,sy=sc)
    hyps=[at(sc,ax,ay) for sc in scales for ax in 'lrc' for ay in 'tbc']
    best=max(hyps,key=lambda p:placement_score(low,im,p)); bs=placement_score(low,im,best)
    for step in (2,1):
        improved=True
        while improved:
            improved=False
            for dx,dy in ((step,0),(-step,0),(0,step),(0,-step)):
                p=dict(best); p['x']+=dx*F; p['y']+=dy*F
                v=placement_score(low,im,p)
                if v>bs: bs,best,improved=v,p,True
    # refine at half resolution: 1-px (=2 page px) moves and 0.25% scale steps
    mid=resize_gray(page_gray,W//2,H//2); f2=2
    bs=placement_score(mid,im,best,f2,'gray')
    improved=True
    while improved:
        improved=False
        cands=[]
        for dx,dy in ((1,0),(-1,0),(0,1),(0,-1)):
            p=dict(best); p['x']+=dx*f2; p['y']+=dy*f2; cands.append(p)
        for k in (1.0025,1/1.0025):
            p=dict(best); cx=p['x']+im['gray'].shape[1]*p['sx']/2; cy=p['y']+im['gray'].shape[0]*p['sy']/2
            p['sx']*=k; p['sy']*=k; p['x']=cx-im['gray'].shape[1]*p['sx']/2; p['y']=cy-im['gray'].shape[0]*p['sy']/2; cands.append(p)
        for p in cands:
            v=placement_score(mid,im,p,f2,'gray')
            if v>bs+1e-4: bs,best,improved=v,p,True
    best['score']=bs
    return best

def paste(page_rgb, page_gray, im, pl, tol=100):
    H,W=page_gray.shape; ih,iw=im['gray'].shape
    bw,bh=int(round(iw*pl['sx'])),int(round(ih*pl['sy']))
    offx,offy=int(round(pl['x'])),int(round(pl['y']))
    x0,y0=max(0,offx),max(0,offy); x1,y1=min(W,offx+bw),min(H,offy+bh)
    if x1<=x0 or y1<=y0: return 0
    big=np.asarray(Image.fromarray(im['rgb']).resize((bw,bh),Image.BILINEAR))
    sub=big[y0-offy:y1-offy, x0-offx:x1-offx]
    pg=page_gray[y0:y1,x0:x1]
    ok=np.abs(lum(sub.astype(np.float32))-pg)<=tol
    region=page_rgb[y0:y1,x0:x1]
    region[ok]=sub[ok]
    return ok.mean()

def placement_score(low, im, pl, f=F, src='small'):
    """NCC between the placed image (at 1/f res) and the page under it."""
    h,w=low.shape
    tw,th=int(round(im['gray'].shape[1]*pl['sx']/f)), int(round(im['gray'].shape[0]*pl['sy']/f))
    ox,oy=int(round(pl['x']/f)), int(round(pl['y']/f))
    x0,y0,x1,y1=max(0,ox),max(0,oy),min(w,ox+tw),min(h,oy+th)
    if x1-x0<8 or y1-y0<8: return -1
    t=resize_gray(im[src],tw,th)[y0-oy:y1-oy, x0-ox:x1-ox]
    return ncc(t,low[y0:y1,x0:x1])

if __name__=='__main__':
    epub,pagesdir,outdir=sys.argv[1:4]; os.makedirs(outdir,exist_ok=True)
    t=time.time(); imgs=load_epub_images(epub); print('colour images:',[i['name'].split('/')[-1] for i in imgs], f'{time.time()-t:.1f}s')
    for f in sorted(glob.glob(pagesdir+'/p*.png')):
        g=np.asarray(Image.open(f).convert('L')).astype(np.float32)
        t=time.time(); ms=find_matches(g,imgs,print)
        if not ms: continue
        rgb=np.stack([g.astype(np.uint8)]*3,-1).copy()
        info=[]
        for m in ms:
            pl=place(m,g); frac=paste(rgb,g,m[2],pl)
            info.append(f"{m[2]['name'].split('/')[-1]} ncc={m[0]:.2f} fit={pl['score']:.2f} at=({pl['x']:.0f},{pl['y']:.0f}) s=({pl['sx']:.3f},{pl['sy']:.3f}) kept={frac:.2f}")
        Image.fromarray(rgb).save(outdir+'/'+os.path.basename(f))
        print(os.path.basename(f), f'{time.time()-t:.2f}s', '; '.join(info))
