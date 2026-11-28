FROM python:3.12-slim

WORKDIR /app
# Liberation Sans: Arial's metrics, for the gig lyrics PDF (lyrics_pdf.py).
RUN apt-get update \
    && apt-get install -y --no-install-recommends fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "10000"]
