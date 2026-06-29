use sudoku_core::Grid;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn init() {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
}

/// Solve a puzzle given 81 digits (0 = empty) as a `Uint8Array` / JS array of numbers.
/// Returns 81 solution digits, or throws a JS error string on failure.
#[wasm_bindgen]
pub fn solve(digits: &[u8]) -> Result<Vec<u8>, JsError> {
    let grid = Grid::from_row_major(digits).map_err(|e| JsError::new(&e.to_string()))?;
    let solved = grid.solve().map_err(|e| JsError::new(&e.to_string()))?;
    Ok(solved.row_major().to_vec())
}

/// Return true if non-zero givens do not conflict.
#[wasm_bindgen]
pub fn validate_givens(digits: &[u8]) -> Result<bool, JsError> {
    let grid = Grid::from_row_major(digits).map_err(|e| JsError::new(&e.to_string()))?;
    Ok(grid.givens_valid())
}
