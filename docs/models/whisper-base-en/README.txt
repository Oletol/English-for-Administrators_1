Speech recognition model used by "Transcribe" in speaking tasks (docs/js/asr-worker.js).

Whisper base.en – OpenAI, MIT licence (https://github.com/openai/whisper).
ONNX export (int8) – k2-fsa/sherpa-onnx, Apache 2.0 licence (https://github.com/k2-fsa/sherpa-onnx).
For this course the token embedding of the decoder was additionally quantised to int8 (per row) so that
the decoder fits the GitHub file limit; the result was checked against the original on test recordings.
The files are split into parts of 24 MB; the browser joins them and keeps them in its cache.

Runtime: onnxruntime-web 1.22.0, MIT licence (docs/js/vendor/ort/).
