import urllib.request, zipfile, os

url = 'https://cdn-ap.flova.tv/download_temp/1387920baa0846cea81c0b80037ee2d3/flova-%E6%A9%98%E7%8C%AB%E6%8D%A1%E5%8F%91%E5%A4%B9%E8%B7%B3%E5%96%B5%E9%98%BF%E9%87%8C%E5%98%8E%E5%A4%9A-202610150900.zip?auth_key=1794646843-0-0-f79c1500c62b3776ab7136a0b786693d'
base = r'D:/ai/runtime/flova_cat_clip'
zippath = os.path.join(base, 'refs.zip')
out = os.path.join(base, 'extracted')
os.makedirs(out, exist_ok=True)

print('downloading...')
urllib.request.urlretrieve(url, zippath)
print('zip size', os.path.getsize(zippath))

with zipfile.ZipFile(zippath) as z:
    names = z.namelist()
    print('entries', len(names))
    for n in names[:40]:
        print(' ', n)
    z.extractall(out)
print('extracted to', out)
# list pngs
pngs = [n for n in names if n.lower().endswith('.png')]
print('png count', len(pngs))
