FROM python:3.13-slim

# libgomp: onnxruntime (Silero VAD, Smart Turn v3)
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY max_worker ./max_worker

ENV PYTHONUNBUFFERED=1 ENV=production PORT=7860
EXPOSE 7860
# One always-on process per container; it runs MAX_CALLS_PER_WORKER calls at once.
CMD ["python", "-m", "max_worker.server"]
