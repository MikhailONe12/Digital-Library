// Custom pdf.js worker entry.
//
// The static imports run in source order during worker startup, so the
// Math.sumPrecise polyfill is installed in the worker's own (clean) global
// scope BEFORE the real pdf.js worker initialises and registers its message
// handler. This fixes garbled font rendering on engines/workers that lack
// Math.sumPrecise. Imported elsewhere via `?worker&url` and assigned to
// pdfjsLib.GlobalWorkerOptions.workerSrc.
import './mathSumPrecise';
import 'pdfjs-dist/build/pdf.worker.min.mjs';
