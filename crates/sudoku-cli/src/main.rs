use std::env;
use std::io::{self, Read};
use std::process::ExitCode;

use sudoku_core::Grid;

fn main() -> ExitCode {
    let mut args = env::args().skip(1);
    match args.next().as_deref() {
        Some("--help") | Some("-h") => {
            print_help();
            ExitCode::SUCCESS
        }
        Some(path) => match solve_image(path) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("error: {e}");
                ExitCode::FAILURE
            }
        },
        None => match solve_stdin() {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("error: {e}");
                ExitCode::FAILURE
            }
        },
    }
}

fn print_help() {
    eprintln!(
        "\
sudoku-solver — Rust Sudoku solver with optional OCR

Usage:
  sudoku-solver              Read 9 lines of 9 digits (0 = empty) from stdin
  sudoku-solver <image>      OCR puzzle from image via rusty-tesseract, then solve
  sudoku-solver -h|--help    Show this help

Web UI (camera + upload) is hosted on GitHub Pages; see README.
"
    );
}

fn solve_stdin() -> Result<(), String> {
    let mut buf = String::new();
    io::stdin()
        .read_to_string(&mut buf)
        .map_err(|e| e.to_string())?;
    let grid = Grid::parse_text(&buf).map_err(|e| e.to_string())?;
    println!("Input:\n{grid}");
    let solved = grid.solve().map_err(|e| e.to_string())?;
    println!("Solution:\n{solved}");
    Ok(())
}

fn solve_image(path: &str) -> Result<(), String> {
    let recognized = sudoku_ocr::recognize_path(path).map_err(|e| e.to_string())?;
    let grid = recognized.to_grid();
    println!("OCR (confidence in brackets where low):\n");
    for r in 0..9 {
        for c in 0..9 {
            let cell = &recognized.cells[r][c];
            let d = cell.digit;
            let mark = match cell.confidence {
                Some(conf) if conf < sudoku_ocr::DEFAULT_CONFIDENCE_THRESHOLD && d == 0 => "?",
                Some(conf) if conf < 70.0 && d > 0 => "*",
                _ => " ",
            };
            if c == 3 || c == 6 {
                print!(" ");
            }
            print!("{d}{mark}");
        }
        println!();
        if r == 2 || r == 5 {
            println!();
        }
    }
    println!("\nParsed grid:\n{grid}");
    let clues: usize = (0..9)
        .flat_map(|r| (0..9).map(move |c| recognized.cells[r][c].digit))
        .filter(|&d| d > 0)
        .count();
    if clues < 30 {
        eprintln!(
            "note: only {clues} OCR clues — some cells may be missing (gray/moiré). Edit low-confidence cells if the solution looks wrong."
        );
    }
    let solved = grid.solve().map_err(|e| e.to_string())?;
    println!("Solution:\n{solved}");
    Ok(())
}
