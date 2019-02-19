struct Sudoku {
	grid: Vec<Vec<usize>>
}

impl Sudoku {
	fn new() -> Self {
		let mut grid = Vec::with_capacity(9);

		for _ in 0..9 {
			let mut input_text = String::new();
			std::io::stdin()
				.read_line(&mut input_text)
				.expect("Failed to read line");

			let vec: Vec<usize> = input_text
				.trim()
				.split(' ')
				.flat_map(str::parse::<usize>)
				.collect::<Vec<_>>();
			grid.push(vec);
		}

		Sudoku {
			grid
		}
	}

	fn show(&self) {
		let mut k = 0;
		for (j, x) in self.grid.iter().enumerate() {
			for j in x {
				if k == 3 || k == 6 {
					print!(" ");
				}
				print!("{} ", j);
				k += 1;
			}
			println!();
			if j == 2 || j == 5 {
				println!();
			}
			k = 0;
		}
	}

	fn find_unassigned_location(&self) -> (bool, usize, usize) {
		for row in 0..9 {
			for col in 0..9 {
				if self.grid[row][col] == 0 {
					return (true, row, col);
				}
			}
		}
		(false, 0, 0)
	}

	fn used_in_row(&self, row: usize, num: usize) -> bool {
		for col in 0..9 {
			if self.grid[row][col] == num {
				return true;
			}
		}
		false
	}


	fn used_in_col(&self, col: usize, num: usize) -> bool {
		for row in 0..9 {
			if self.grid[row][col] == num {
				return true;
			}
		}
		false
	}

	fn used_in_box(&self, box_start_row: usize, box_start_col: usize, num: usize) -> bool {
		for row in 0..3 {
			for col in 0..3 {
				if self.grid[row + box_start_row][col + box_start_col] == num {
					return true;
				}
			}
		}

		false
	}

	fn is_safe(&self, row: usize, col: usize, num: usize) -> bool {
		!self.used_in_row(row, num)
			&& !self.used_in_col(col, num)
			&& !self.used_in_box(row - row % 3, col - col % 3, num)
			&& self.grid[row][col] == 0
	}

	fn backtrace_solve(&mut self) -> bool{
		let (condition,row,col) = self.find_unassigned_location();

		if !condition{
			return true;
		}

		for num in 1..=9{
			if self.is_safe(row,col,num){
				self.grid[row][col] = num;

				if self.backtrace_solve(){
					return true;
				}

				self.grid[row][col] = 0;
			}
		}

		false
	}
}

fn main() {
	let mut k = Sudoku::new();

	k.show();

	k.backtrace_solve();

	println!();

	k.show();

}