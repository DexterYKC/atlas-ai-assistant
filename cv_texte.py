# Lit le texte d'un CV (PDF) EN LOCAL et retire les coordonnées personnelles avant que le texte ne parte vers une IA.
#   python cv_texte.py <fichier.pdf>   -> JSON { ok, pages, caracteres, texte, retire: { emails, telephones } }
# Rien n'est envoyé nulle part ici. Le chemin doit se trouver dans JARVIS_DOSSIER (F:\Jarvis) : aucun autre fichier n'est lu.
import json, os, re, sys

for _f in (sys.stdout, sys.stderr):
    try: _f.reconfigure(encoding='utf-8')
    except Exception: pass

def sortir(o, code=0):
    print(json.dumps(o, ensure_ascii=False)); sys.exit(code)

def epurer(t):
    n = {'emails': 0, 'telephones': 0}
    def em(m): n['emails'] += 1; return '[email retiré]'
    def tel(m):
        if len(re.sub(r'\D', '', m.group(0))) < 8 or re.fullmatch(r'(?:19|20)\d{2}\s*[-–]\s*(?:19|20)\d{2}', m.group(0).strip()): return m.group(0)      # une période (2024 - 2025) n'est pas un numéro
        n['telephones'] += 1; return '[téléphone retiré]'
    t = re.sub(r'[\w.+-]+@[\w-]+(?:\.[\w-]+)+', em, t)
    t = re.sub(r'(?<![\w/])\+?\d[\d ().\-]{7,}\d', tel, t)                  # numéros (avec +, espaces, points, tirets, parenthèses)
    return t, n

def main():
    if len(sys.argv) < 2: sortir({'ok': False, 'raison': 'aucun fichier'}, 2)
    dossier = os.environ.get('JARVIS_DOSSIER', '')
    chemin = os.path.abspath(sys.argv[1])
    if not dossier or not chemin.lower().startswith(os.path.abspath(dossier).lower() + os.sep): sortir({'ok': False, 'raison': 'fichier refusé : il doit être DANS le dossier Jarvis'}, 4)
    if not os.path.exists(chemin): sortir({'ok': False, 'raison': 'CV introuvable : dépose-le dans le dossier profil de Jarvis sous le nom cv.pdf'}, 3)
    try: from pypdf import PdfReader
    except Exception: sortir({'ok': False, 'raison': "le lecteur de PDF (pypdf) n'est pas installé : pip install pypdf"}, 2)
    try:
        r = PdfReader(chemin); texte = '\n'.join((p.extract_text() or '') for p in r.pages[:6])
    except Exception as e:
        sortir({'ok': False, 'raison': f'PDF illisible : {str(e)[:100]}'}, 3)
    texte = re.sub(r'[ \t]+', ' ', texte); texte = re.sub(r'\n{3,}', '\n\n', texte).strip()
    if len(texte) < 200: sortir({'ok': False, 'raison': "presque aucun texte dans ce PDF (image scannée ?) : je ne peux pas l'analyser"}, 3)
    texte, retire = epurer(texte)
    sortir({'ok': True, 'pages': len(r.pages), 'caracteres': len(texte), 'texte': texte[:12000], 'retire': retire})

if __name__ == '__main__':
    main()
