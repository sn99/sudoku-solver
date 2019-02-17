# sudoku-solver

[![Build Status](https://travis-ci.com/sn99/sudoku-solver.svg?branch=master)](https://travis-ci.com/sn99/sudoku-solver)

A sudoku solver in Rust

Usage : `cargo run --release`

Use `0` to show blank spaces in the grid

Eg - 
```
0 0 8 0 0 0 9 0 0
3 5 0 0 0 0 0 8 6
0 7 0 9 0 6 0 3 0
8 0 2 0 9 0 6 0 1
0 0 0 7 0 8 0 0 0
7 0 5 0 2 0 4 0 8
0 2 0 1 0 3 0 6 0
9 6 0 0 0 0 0 5 2
0 0 3 0 0 0 7 0 0
 ```
gives
```
6 1 8  5 3 2  9 4 7 
3 5 9  4 1 7  2 8 6 
2 7 4  9 8 6  1 3 5 

8 4 2  3 9 5  6 7 1 
1 9 6  7 4 8  5 2 3 
7 3 5  6 2 1  4 9 8 

4 2 7  1 5 3  8 6 9 
9 6 1  8 7 4  3 5 2 
5 8 3  2 6 9  7 1 4
```
