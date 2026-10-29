"""Generates 3 Finnish-style test receipts plus expected JSON for SplitIt QA.
Run: python3 make_receipts.py   (needs Pillow)"""
import json, os, random
from PIL import Image, ImageDraw, ImageFont, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
FONT_B = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"
W, COLS = 640, 36          # image width, characters per line
f = ImageFont.truetype(FONT, 26)
fb = ImageFont.truetype(FONT_B if os.path.exists(FONT_B) else FONT, 26)
fbig = ImageFont.truetype(FONT_B if os.path.exists(FONT_B) else FONT, 34)

def eur(c):  # cents -> "12,50"
    s = "-" if c < 0 else ""
    c = abs(c)
    return f"{s}{c // 100},{c % 100:02d}"

def lr(left, right):
    return left + " " * max(1, COLS - len(left) - len(right)) + right

def render(lines):
    lh = 36
    img = Image.new("L", (W, 60 + lh * len(lines) + 60), 252)
    d = ImageDraw.Draw(img)
    y = 50
    for kind, text in lines:
        font = fbig if kind == "big" else fb if kind == "bold" else f
        if kind in ("big", "center"):
            w = d.textlength(text, font=font)
            d.text(((W - w) / 2, y), text, fill=20, font=font)
        else:
            d.text((30, y), text, fill=20, font=font)
        y += lh
    return img

def save(name, img, expected):
    img.convert("RGB").save(os.path.join(HERE, name + ".jpg"), quality=90)
    with open(os.path.join(HERE, name + ".expected.json"), "w", encoding="utf-8") as fh:
        json.dump(expected, fh, ensure_ascii=False, indent=2)

def header(name, addr, ytunnus, date):
    return [("big", name), ("center", addr), ("center", "Y-tunnus " + ytunnus), ("n", ""),
            ("n", lr(date, "Kassa 2")), ("n", "-" * COLS)]

# ---------- 1. clean, 5 lines ----------
items1 = [("Margherita", 1, 1450), ("Lohikeitto", 1, 1690), ("Caesar-salaatti", 1, 1290),
          ("Karhu III 0,5l", 1, 780), ("Tiramisu", 1, 850)]
total1 = sum(p for _, _, p in items1)
lines = header("RAVINTOLA KALLION KULMA", "Helsinginkatu 12, 00500 Helsinki", "1234567-8", "29.10.2026 19:42")
lines += [("n", lr(n, eur(p))) for n, q, p in items1]
lines += [("n", "-" * COLS), ("bold", lr("YHTEENSÄ EUR", eur(total1))), ("n", ""),
          ("n", lr("KORTTI / VISA", eur(total1))), ("n", ""), ("center", "KIITOS KÄYNNISTÄ!")]
save("receipt1_clean", render(lines), {
    "description": "Clean receipt, 5 single-qty lines, VAT included, no tax line.",
    "items": [{"name": n, "qty": q, "priceCents": p} for n, q, p in items1],
    "taxCents": 0, "currency": "EUR", "receiptTotalCents": total1})

# ---------- 2. qty lines + discount + ALV block ----------
items2 = [("Hampurilainen", 2, 990), ("Coca-Cola 0,33l", 3, 350), ("Pizza Pepperoni", 1, 1590),
          ("Ranskalaiset", 1, 490), ("Lapin Kulta 0,5l", 2, 820)]
discount = -200
lines = header("BISTRO PUNAVUORI", "Iso Roobertinkatu 20, 00120 Helsinki", "2345678-9", "29.10.2026 13:05")
for n, q, unit in items2:
    if q > 1:
        lines += [("n", n), ("n", lr(f"  {q} x {eur(unit)}", eur(q * unit)))]
    else:
        lines += [("n", lr(n, eur(unit)))]
lines += [("n", lr("Alennus lounasetu", eur(discount)))]
food = 2 * 990 + 3 * 350 + 1590 + 490 + discount   # 14 % VAT group (discount on food)
alc = 2 * 820                                       # 25,5 % VAT group
total2 = food + alc
vat14 = round(food * 14 / 114); vat255 = round(alc * 25.5 / 125.5)
lines += [("n", "-" * COLS), ("bold", lr("YHTEENSÄ EUR", eur(total2))), ("n", ""),
          ("n", lr("KORTTI / MASTERCARD", eur(total2))), ("n", ""),
          ("n", "ALV%      VEROTON     VERO   VEROLL."),
          ("n", f"14,0  {eur(food - vat14):>11}{eur(vat14):>9}{eur(food):>9}"),
          ("n", f"25,5  {eur(alc - vat255):>11}{eur(vat255):>9}{eur(alc):>9}"),
          ("n", f"YHT.  {eur(total2 - vat14 - vat255):>11}{eur(vat14 + vat255):>9}{eur(total2):>9}"),
          ("n", ""), ("center", "KIITOS JA TERVETULOA UUDELLEEN")]
save("receipt2_qty_vat_discount", render(lines), {
    "description": "Qty lines (unit price on a second line, line total on the right), a discount line, and an ALV (VAT) summary block. Prices include VAT, so tax must be 0/null. The ALV block, YHTEENSÄ and KORTTI lines must NOT become items.",
    "items": [{"name": n, "qty": q, "priceCents": q * u} for n, q, u in items2],
    "taxCents": 0, "currency": "EUR",
    "discountLine": {"name": "Alennus lounasetu", "priceCents": discount},
    "receiptTotalCents": total2,
    "note": "Item lines sum to %d; receipt total is %d after the discount. The contract has no discount field and parseReceipt skips negative prices, so the expected app result is the 5 items (sum %d) and the 2,00 discount is lost unless handled." % (total2 - discount, total2, total2 - discount)})

# ---------- 3. rotated + noisy ----------
items3 = [("Cappuccino", 2, 490), ("Korvapuusti", 2, 380), ("Kinkkukolmioleipä", 1, 890),
          ("Tuoremehu", 1, 450), ("Mustikkapiirakka", 1, 620)]
total3 = sum(q * u for _, q, u in items3)
lines = header("CAFÉ ESPLANAD", "Pohjoisesplanadi 37, 00100 Helsinki", "3456789-0", "29.10.2026 10:17")
for n, q, unit in items3:
    lines += [("n", lr(f"{q} {n}", eur(q * unit)))]
lines += [("n", "-" * COLS), ("bold", lr("YHTEENSÄ EUR", eur(total3))), ("n", ""),
          ("n", lr("KÄTEINEN", "40,00")), ("n", lr("TAKAISIN", eur(4000 - total3))),
          ("n", ""), ("center", "Hyvää päivänjatkoa!")]
img = render(lines)
random.seed(7)
px = img.load()
for _ in range(img.width * img.height // 25):          # speckle noise
    x, y = random.randrange(img.width), random.randrange(img.height)
    px[x, y] = random.choice([30, 120, 200])
img = img.filter(ImageFilter.GaussianBlur(0.8))
bg = Image.new("L", (img.width + 160, img.height + 160), 120)  # table behind the paper
bg.paste(img, (80, 80))
bg = bg.rotate(4.5, resample=Image.BICUBIC, fillcolor=120, expand=True)
save("receipt3_rotated_noisy", bg, {
    "description": "Rotated about 4.5 degrees, speckle noise and slight blur, on a grey background. Qty is a prefix on the line. Cash payment and change lines must NOT become items.",
    "items": [{"name": n, "qty": q, "priceCents": q * u} for n, q, u in items3],
    "taxCents": 0, "currency": "EUR", "receiptTotalCents": total3})
print("ok", total1, total2, total3)
