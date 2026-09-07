FROM python:3.12-slim

# libgl1/libglib2.0-0 are needed by opencv-python-headless (added in a later
# build phase); harmless to have ready now.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "10000"]
