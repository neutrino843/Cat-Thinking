# Document import fixtures

These files are small project-owned regression samples for Cat-Thinking's browser-side document import.

## Files

- `structured-course.pdf`: two-page PDF with a real text layer, page-edge numbers, body numbers, and a simple table.
- `scanned-no-text.pdf`: image-only PDF with no text layer. Import must stop with the OCR-required message.
- `structured-course.docx`: OOXML document with Heading 1 and Heading 2 styles, normal paragraphs, a tab, Chinese text, and a table.
- `expected.json`: stable assertions used by E2E tests.
- `manifest.json`: MIME, size, provenance description, and SHA-256 for each binary fixture.

## Regeneration

Run `scripts/generate_document_fixtures.py` with the bundled artifact Python runtime. The generator fixes PDF metadata and DOCX ZIP timestamps so repeated runs are stable when the same library versions are used.

The fixtures contain no third-party source material. They were generated for this repository and may be redistributed with it.

Malformed ZIP paths, encrypted archives, XML entities, and compression-bomb boundaries remain in-memory unit-test cases. They are intentionally not stored as reusable binary files.
