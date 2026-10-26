import re, unicodedata
def norm(s):
    return re.sub(r"[\W_]+", "", unicodedata.normalize("NFKC", s).upper())

def read_stm(p):
    segs = []
    for ln in p.read_text().splitlines():
        f = ln.split(maxsplit=5)
        if len(f) == 6:
            segs.append((f[2], float(f[3]), float(f[4]), norm(f[5])))
    return segs

def ovl_frac(seg, segs):
    spk, s, e, _ = seg
    iv = sorted((max(s, b), min(e, c)) for (k, b, c, _) in segs if k != spk and c > s and b < e)
    tot, cur_s, cur_e = 0.0, None, None
    for a, b in iv:
        if cur_e is None or a > cur_e:
            if cur_e is not None: tot += cur_e - cur_s
            cur_s, cur_e = a, b
        else:
            cur_e = max(cur_e, b)
    if cur_e is not None: tot += cur_e - cur_s
    return tot / max(e - s, 1e-6)

