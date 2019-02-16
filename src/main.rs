#[derive(Debug, Clone)]
struct Cell {
	value: usize,
	possibilities: Option<Vec<usize>>,
}

impl Cell {
	fn new(value: usize) -> Self {
		let possibilities = vec![1, 2, 3, 4, 5, 6, 7, 8, 9];
		match value {
			0 => {
				return Cell {
					value,
					possibilities: Some(possibilities),
				};
			}

			_ => {
				return Cell {
					value,
					possibilities: None,
				};
			}
		}
	}
}

#[derive(Debug, Clone)]
struct Grid {
	grid: Vec<Vec<Cell>>,
	mutated_state: bool,
}

impl Grid {
	fn new() -> Self {
		let mut grid = Vec::with_capacity(9);
		let mutated_state = false;

		let k = Grid::input_sudoku();

		for q in k {
			let mut temp_grid_line = Vec::with_capacity(9);
			for w in q {
				temp_grid_line.push(Cell::new(w));
			}
			grid.push(temp_grid_line);
		}

		Grid {
			grid,
			mutated_state,
		}
	}

	fn input_sudoku() -> Vec<Vec<usize>> {
		let mut vec1 = Vec::with_capacity(9);

		for _ in 0..9 {
			let mut input_text = String::new();
			std::io::stdin()
				.read_line(&mut input_text)
				.expect("Failed to read line");

			let vec2: Vec<usize> = input_text
				.trim()
				.split(' ')
				.flat_map(str::parse::<usize>)
				.collect::<Vec<_>>();
			vec1.push(vec2);
		}

		vec1
	}

	fn show(&self) {
		let mut k = 0;
		let mut j = 0;
		for x in &self.grid {
			for j in x {
				if k == 3 || k == 6 {
					print!(" ");
				}
				print!("{} ", j.value);
				k += 1;
			}
			println!();
			if j == 2 || j == 5 {
				println!();
			}
			j += 1;
			k = 0;
		}
	}

	fn solve(&mut self) {
		loop {
			self.remove_possibilities_row();
			self.remove_possibilities_column();
			self.remove_possibilities_box();
			self.change_value_one_possibility();
			self.change_value_others_possibility();

			if !self.mutated_state {
				break;
			}

			self.mutated_state = false;
		}
	}

	fn change_value_one_possibility(&mut self) {
		for row in &mut self.grid {
			for column in row {
				match column.possibilities {
					Some(ref possibilities) => {
						if possibilities.len() == 1 {
							column.value = possibilities.clone().pop().unwrap();
							column.possibilities = None;
							self.mutated_state = true;
						}
					}
					None => continue,
				}
			}
		}
	}

	fn change_value_others_possibility(&mut self) {
		let mut column_jump = 0;
		let mut row_jump = 0;
		for _ in 0..3 {
			for _ in 0..3 {
				let mut q = Vec::new();
				for row in 0..3 {
					for column in 0..3 {
						match &self.grid[row + row_jump][column + column_jump].possibilities.clone() {
							Some(possibilities) => {
								for k in possibilities {
									q.push(k.clone());
								}
							}
							None => ()
						}
					}
				}

				q.sort();
				q.dedup();

				for row in 0..3 {
					for column in 0..3 {
						match &self.grid[row + row_jump][column + column_jump].possibilities.clone() {
							Some(possibilities) => {
								for k in possibilities {
									match q.iter().find(|&&x| x == *k) {
										None => {
											self.grid[row + row_jump][column + column_jump].value = *k;
											self.grid[row + row_jump][column + column_jump].possibilities = None;
											self.mutated_state = true;
										}
										_ => ()
									}
								}
							}
							_ => ()
						}
					}
				}
				column_jump += 3;
			}
			row_jump += 3;
			column_jump = 0;
		}
	}

	fn remove_possibilities_box(&mut self) {
		let zx = self.grid.clone();
		let mut column_jump = 0;
		let mut row_jump = 0;
		for _ in 0..3 {
			for _ in 0..3 {
				for row in 0..3 {
					for column in 0..3 {
						match &mut self.grid[row + row_jump][column + column_jump].possibilities {
							Some(possibilities) => {
								for x in 0..3 {
									for y in 0..3 {
										let q = zx[x + row_jump][y + column_jump].value;
										if x != row + row_jump && y != column + column_jump {
											possibilities.retain(|x| *x != q);
										}
									}
								}
							}
							None => continue,
						}
					}
				}
				column_jump += 3;
			}
			row_jump += 3;
			column_jump = 0;
		}
	}

	fn remove_possibilities_column(&mut self) {
		let zx = self.grid.clone();
		for row in 0..9 {
			for column in 0..9 {
				match &mut self.grid[row][column].possibilities {
					Some(possibilities) => {
						for i in 0..9 {
							if i != row {
								let q = zx[i][column].value;
								possibilities.retain(|x| *x != q);
							}
						}
					}
					None => continue,
				}
			}
		}
	}

	fn remove_possibilities_row(&mut self) {
		for row in 0..9 {
			for column in 0..9 {
				let zx = self.grid.clone();

				match &mut self.grid[row][column].possibilities {
					Some(possibilities) => {
						for i in 0..9 {
							if i != column {
								let q = zx[row][i].value;
								possibilities.retain(|x| *x != q);
							}
						}
					}
					None => continue,
				}
			}
		}
	}
}

fn main() {
	let mut k = Grid::new();

	println!("{:?}\n", k);

	k.solve();

	println!("\n{:#?}", k);

	k.show();
}

/*
0 0 8 0 0 0 9 0 0
3 5 0 0 0 0 0 8 6
0 7 0 9 0 6 0 3 0
8 0 2 0 9 0 6 0 1
0 0 0 7 0 8 0 0 0
7 0 5 0 2 0 4 0 8
0 2 0 1 0 3 0 6 0
9 6 0 0 0 0 0 5 2
0 0 3 0 0 0 7 0 0

0 0 0 9 4 0 0 6 1
0 1 0 0 0 6 0 0 0
0 0 5 0 1 0 2 8 0
1 6 0 0 0 0 8 3 0
0 0 0 0 0 0 0 0 0
0 2 8 0 0 0 0 4 6
0 3 1 0 9 0 6 0 0
0 0 0 1 0 0 0 5 0
4 9 0 0 5 8 0 0 0
*/
