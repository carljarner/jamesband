"""Small PDF helpers shared by gig_bundle.py and setlist.py: a plain-text
note page (for listing songs that couldn't be found), and merging a list of
PDFs page-by-page into one.
"""

from io import BytesIO

from pypdf import PdfReader, PdfWriter
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas


def note_page_pdf(heading: str, lines: list[str]) -> bytes:
    buf = BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    page_w, page_h = A4
    c.setFont("Helvetica-Bold", 14)
    c.drawString(40, page_h - 60, heading)
    c.setFont("Helvetica", 11)
    y = page_h - 90
    for line in lines:
        c.drawString(40, y, f"• {line}")
        y -= 20
    c.save()
    return buf.getvalue()


def merge_pdfs(pdf_list: list[bytes]) -> bytes:
    writer = PdfWriter()
    for pdf_bytes in pdf_list:
        reader = PdfReader(BytesIO(pdf_bytes))
        for page in reader.pages:
            writer.add_page(page)
    buf = BytesIO()
    writer.write(buf)
    return buf.getvalue()
