//! Sudoku grid representation and backtracking solver.

use std::fmt;

/// Digit 1–9, or 0 for empty.
pub type Digit = u8;

/// Fixed 9×9 Sudoku grid. Row-major: `cells[row][col]`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Grid {
    cells: [[Digit; 9]; 9],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseError {
    WrongRowCount(usize),
    WrongColCount { row: usize, cols: usize },
    InvalidDigit { row: usize, col: usize, value: u8 },
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ParseError::WrongRowCount(n) => write!(f, "expected 9 rows, got {n}"),
            ParseError::WrongColCount { row, cols } => {
                write!(f, "row {row}: expected 9 columns, got {cols}")
            }
            ParseError::InvalidDigit { row, col, value } => {
                write!(f, "invalid digit {value} at ({row}, {col}); use 0–9")
            }
        }
    }
}

impl std::error::Error for ParseError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SolveError {
    Unsolvable,
    InvalidGiven,
}

impl fmt::Display for SolveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SolveError::Unsolvable => write!(f, "puzzle has no solution"),
            SolveError::InvalidGiven => write!(f, "given clues violate Sudoku rules"),
        }
    }
}

impl std::error::Error for SolveError {}

/// One recognized cell with optional OCR confidence in \[0, 100\].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RecognizedCell {
    pub digit: Digit,
    /// Confidence 0–100; `None` if not from OCR.
    pub confidence: Option<f32>,
}

/// 9×9 recognition result (digits + confidence for UI highlighting).
#[derive(Clone, Debug, PartialEq)]
pub struct RecognizedGrid {
    pub cells: [[RecognizedCell; 9]; 9],
}

impl RecognizedGrid {
    pub fn empty() -> Self {
        let cell = RecognizedCell {
            digit: 0,
            confidence: None,
        };
        Self {
            cells: [[cell; 9]; 9],
        }
    }

    pub fn to_grid(&self) -> Grid {
        let mut cells = [[0u8; 9]; 9];
        for r in 0..9 {
            for c in 0..9 {
                cells[r][c] = self.cells[r][c].digit;
            }
        }
        Grid { cells }
    }

    /// Flat row-major digits for WASM / JS.
    pub fn digits_row_major(&self) -> [Digit; 81] {
        let mut out = [0u8; 81];
        for r in 0..9 {
            for c in 0..9 {
                out[r * 9 + c] = self.cells[r][c].digit;
            }
        }
        out
    }

    /// Flat confidences; `-1.0` means unknown.
    pub fn confidences_row_major(&self) -> [f32; 81] {
        let mut out = [-1.0f32; 81];
        for r in 0..9 {
            for c in 0..9 {
                out[r * 9 + c] = self.cells[r][c].confidence.unwrap_or(-1.0);
            }
        }
        out
    }
}

impl Grid {
    pub fn empty() -> Self {
        Self {
            cells: [[0; 9]; 9],
        }
    }

    pub fn from_cells(cells: [[Digit; 9]; 9]) -> Result<Self, ParseError> {
        for (r, row) in cells.iter().enumerate() {
            for (c, &v) in row.iter().enumerate() {
                if v > 9 {
                    return Err(ParseError::InvalidDigit {
                        row: r,
                        col: c,
                        value: v,
                    });
                }
            }
        }
        Ok(Self { cells })
    }

    /// Parse from 81 digits row-major (0 = empty).
    pub fn from_row_major(digits: &[Digit]) -> Result<Self, ParseError> {
        if digits.len() != 81 {
            return Err(ParseError::WrongRowCount(digits.len().div_ceil(9).max(1)));
        }
        let mut cells = [[0u8; 9]; 9];
        for r in 0..9 {
            for c in 0..9 {
                let v = digits[r * 9 + c];
                if v > 9 {
                    return Err(ParseError::InvalidDigit {
                        row: r,
                        col: c,
                        value: v,
                    });
                }
                cells[r][c] = v;
            }
        }
        Ok(Self { cells })
    }

    /// Parse lines like `"0 0 8 0 0 0 9 0 0"` (9 lines).
    pub fn parse_text(text: &str) -> Result<Self, ParseError> {
        let rows: Vec<&str> = text
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .collect();
        if rows.len() != 9 {
            return Err(ParseError::WrongRowCount(rows.len()));
        }
        let mut cells = [[0u8; 9]; 9];
        for (r, line) in rows.iter().enumerate() {
            let nums: Vec<u8> = line
                .split_whitespace()
                .filter_map(|s| s.parse().ok())
                .collect();
            if nums.len() != 9 {
                return Err(ParseError::WrongColCount {
                    row: r,
                    cols: nums.len(),
                });
            }
            for (c, &v) in nums.iter().enumerate() {
                if v > 9 {
                    return Err(ParseError::InvalidDigit {
                        row: r,
                        col: c,
                        value: v,
                    });
                }
                cells[r][c] = v;
            }
        }
        Ok(Self { cells })
    }

    pub fn get(&self, row: usize, col: usize) -> Digit {
        self.cells[row][col]
    }

    pub fn set(&mut self, row: usize, col: usize, digit: Digit) {
        self.cells[row][col] = digit;
    }

    pub fn cells(&self) -> &[[Digit; 9]; 9] {
        &self.cells
    }

    pub fn row_major(&self) -> [Digit; 81] {
        let mut out = [0u8; 81];
        for r in 0..9 {
            for c in 0..9 {
                out[r * 9 + c] = self.cells[r][c];
            }
        }
        out
    }

    /// True if all non-zero clues are consistent (no conflicts).
    pub fn givens_valid(&self) -> bool {
        for r in 0..9 {
            for c in 0..9 {
                let n = self.cells[r][c];
                if n == 0 {
                    continue;
                }
                for cc in 0..9 {
                    if cc != c && self.cells[r][cc] == n {
                        return false;
                    }
                }
                for rr in 0..9 {
                    if rr != r && self.cells[rr][c] == n {
                        return false;
                    }
                }
                let br = r - r % 3;
                let bc = c - c % 3;
                for rr in br..br + 3 {
                    for cc in bc..bc + 3 {
                        if (rr != r || cc != c) && self.cells[rr][cc] == n {
                            return false;
                        }
                    }
                }
            }
        }
        true
    }

    fn find_unassigned(&self) -> Option<(usize, usize)> {
        for row in 0..9 {
            for col in 0..9 {
                if self.cells[row][col] == 0 {
                    return Some((row, col));
                }
            }
        }
        None
    }

    fn used_in_row(&self, row: usize, num: Digit) -> bool {
        (0..9).any(|col| self.cells[row][col] == num)
    }

    fn used_in_col(&self, col: usize, num: Digit) -> bool {
        (0..9).any(|row| self.cells[row][col] == num)
    }

    fn used_in_box(&self, box_start_row: usize, box_start_col: usize, num: Digit) -> bool {
        for row in 0..3 {
            for col in 0..3 {
                if self.cells[row + box_start_row][col + box_start_col] == num {
                    return true;
                }
            }
        }
        false
    }

    fn is_safe(&self, row: usize, col: usize, num: Digit) -> bool {
        !self.used_in_row(row, num)
            && !self.used_in_col(col, num)
            && !self.used_in_box(row - row % 3, col - col % 3, num)
            && self.cells[row][col] == 0
    }

    fn backtrack(&mut self) -> bool {
        let Some((row, col)) = self.find_unassigned() else {
            return true;
        };
        for num in 1..=9 {
            if self.is_safe(row, col, num) {
                self.cells[row][col] = num;
                if self.backtrack() {
                    return true;
                }
                self.cells[row][col] = 0;
            }
        }
        false
    }

    /// Solve and return the solved grid.
    pub fn solve(&self) -> Result<Grid, SolveError> {
        if !self.givens_valid() {
            return Err(SolveError::InvalidGiven);
        }
        let mut g = self.clone();
        if g.backtrack() {
            Ok(g)
        } else {
            Err(SolveError::Unsolvable)
        }
    }
}

impl fmt::Display for Grid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (j, row) in self.cells.iter().enumerate() {
            for (k, d) in row.iter().enumerate() {
                if k == 3 || k == 6 {
                    write!(f, " ")?;
                }
                write!(f, "{d} ")?;
            }
            writeln!(f)?;
            if j == 2 || j == 5 {
                writeln!(f)?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
0 0 8 0 0 0 9 0 0
3 5 0 0 0 0 0 8 6
0 7 0 9 0 6 0 3 0
8 0 2 0 9 0 6 0 1
0 0 0 7 0 8 0 0 0
7 0 5 0 2 0 4 0 8
0 2 0 1 0 3 0 6 0
9 6 0 0 0 0 0 5 2
0 0 3 0 0 0 7 0 0
";

    const SOLUTION: &str = "\
6 1 8 5 3 2 9 4 7
3 5 9 4 1 7 2 8 6
2 7 4 9 8 6 1 3 5
8 4 2 3 9 5 6 7 1
1 9 6 7 4 8 5 2 3
7 3 5 6 2 1 4 9 8
4 2 7 1 5 3 8 6 9
9 6 1 8 7 4 3 5 2
5 8 3 2 6 9 7 1 4
";

    #[test]
    fn solves_readme_example() {
        let g = Grid::parse_text(SAMPLE).unwrap();
        let solved = g.solve().unwrap();
        let expected = Grid::parse_text(SOLUTION).unwrap();
        assert_eq!(solved, expected);
    }

    #[test]
    fn rejects_invalid_givens() {
        let mut cells = [[0u8; 9]; 9];
        cells[0][0] = 1;
        cells[0][1] = 1;
        let g = Grid::from_cells(cells).unwrap();
        assert_eq!(g.solve(), Err(SolveError::InvalidGiven));
    }

    #[test]
    fn row_major_roundtrip() {
        let g = Grid::parse_text(SAMPLE).unwrap();
        let rm = g.row_major();
        let g2 = Grid::from_row_major(&rm).unwrap();
        assert_eq!(g, g2);
    }
}
