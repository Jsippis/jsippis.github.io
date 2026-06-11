# Stockfish WASM for Chesstein review

This folder vendors the lite single-threaded browser build from `stockfish` npm package version 18.0.7.

Source package: https://www.npmjs.com/package/stockfish
Source repository: https://github.com/nmrugg/stockfish.js
Official Stockfish project: https://github.com/official-stockfish/Stockfish

Included engine files:

- `stockfish-18-lite-single.js`
- `stockfish-18-lite-single.wasm`

The lite single-threaded build was chosen because it works on normal GitHub Pages hosting without special cross-origin isolation headers and is small enough for a static site review feature.

Stockfish.js and Stockfish-derived engine builds are GPL-3.0 licensed. See `COPYING.txt`.
