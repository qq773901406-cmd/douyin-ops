import urllib.request, zipfile, os

url = "https://cdn-ap.flova.tv/download_temp/1387920baa0846cea81c0b80037ee2d3/flova-%E6%A9%99%E7%8C%AB%E6%8D%A1%E5%8F%91%E5%A4%B9%E8%B7%B3%E5%96%B5%E9%98%BF%E9%87%8C%E5%98%8E%E5%A4%9A-202610150939.zip?auth_key=1794649214-0-0-554f6950073414bdfff591d8f996fd8c"
out_dir = r"D:/ai/runtime/flova_cat_clip/extracted_v2"
os.makedirs(out_dir, exist_ok=True)
zip_path = os.path.join(out_dir, "flova.zip")
print("downloading...")
urllib.request.urlretrieve(url, zip_path)
print("extracting...")
with zipfile.ZipFile(zip_path) as z:
    z.extractall(out_dir)
print("--- png files ---")
for root, _, files in os.walk(out_dir):
    for f in sorted(files):
        if f.lower().endswith(('.png', '.jpg', '.jpeg', '.webp')):
            print(os.path.join(root, f))
