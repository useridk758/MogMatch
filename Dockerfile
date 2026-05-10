FROM python:3.11-slim

# System deps for OpenCV
RUN apt-get update && apt-get install -y \
    libgl1 \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies first (layer caching)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy all source files
COPY . .

EXPOSE 3000

# 0.0.0.0 is critical — makes server reachable from other devices
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "3000"]
