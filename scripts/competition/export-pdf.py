"""Export visually reviewed slide renders as a six-page, image-based PDF fallback."""
import argparse
import json
from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from pypdf import PdfReader

parser = argparse.ArgumentParser()
parser.add_argument('--slides', required=True)
parser.add_argument('--output', required=True)
args = parser.parse_args()
slides = Path(args.slides).resolve()
output = Path(args.output).resolve()
output.parent.mkdir(parents=True, exist_ok=True)
document = canvas.Canvas(str(output), pagesize=(960, 540))
document.setTitle('CatThinking competition working draft')
document.setAuthor('CatThinking')
document.setSubject('Image-based PDF of six visually reviewed editable presentation slides')
for number in range(1, 7):
    image = ImageReader(str(slides / f'slide-{number}.png'))
    document.drawImage(image, 0, 0, width=960, height=540, preserveAspectRatio=True)
    document.showPage()
document.save()
reader = PdfReader(str(output))
assert len(reader.pages) == 6
assert all(float(page.mediabox.width) == 960 and float(page.mediabox.height) == 540 for page in reader.pages)
print(json.dumps({'output': str(output), 'pages': len(reader.pages), 'kind': 'image-based PDF; editable text stays in PPTX'}, ensure_ascii=False))
