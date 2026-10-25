//! ライフゲームの WebAssembly 版。
//! engine.js の JS 版と同じ計算を、32ビットではなく64ビット単位で行う。
//!
//! 盤面は1マス1ビット。1行は cols / 64 個の u64 で、ビット i が左から i 番目のマス。
//! リトルエンディアンなので、JS から Uint32Array で見ると JS 版と同じ並びになる。
//! 上下左右の端はつながっている（トーラス）。

pub struct Life {
    words: usize, // 1行あたりの u64 の数
    rows: usize,
    cur: Vec<u64>,
    next: Vec<u64>,
}

/// cols は 64 の倍数にすること。
#[no_mangle]
pub extern "C" fn life_new(cols: u32, rows: u32) -> *mut Life {
    let words = cols as usize / 64;
    let len = words * rows as usize;
    Box::into_raw(Box::new(Life { words, rows: rows as usize, cur: vec![0; len], next: vec![0; len] }))
}

/// # Safety
/// life_new で作ったポインタを1回だけ渡すこと。
#[no_mangle]
pub unsafe extern "C" fn life_free(life: *mut Life) {
    drop(Box::from_raw(life));
}

/// 今の盤面の先頭。step のたびに入れ替わるので、毎回取り直すこと。
///
/// # Safety
/// life_new で作った有効なポインタを渡すこと。
#[no_mangle]
pub unsafe extern "C" fn life_cells(life: *mut Life) -> *mut u64 {
    (*life).cur.as_mut_ptr()
}

/// n 世代進める。
///
/// # Safety
/// life_new で作った有効なポインタを渡すこと。
#[no_mangle]
pub unsafe extern "C" fn life_step(life: *mut Life, n: u32) {
    let life = &mut *life;
    for _ in 0..n {
        life.step();
    }
}

impl Life {
    fn step(&mut self) {
        let (words, rows) = (self.words, self.rows);
        for r in 0..rows {
            let up = &self.cur[(if r == 0 { rows - 1 } else { r - 1 }) * words..][..words];
            let mid = &self.cur[r * words..][..words];
            let down = &self.cur[(if r + 1 == rows { 0 } else { r + 1 }) * words..][..words];
            let out = &mut self.next[r * words..][..words];
            for k in 0..words {
                let kl = if k == 0 { words - 1 } else { k - 1 };
                let kr = if k + 1 == words { 0 } else { k + 1 };
                out[k] = next_word(
                    [up[kl], up[k], up[kr]],
                    [mid[kl], mid[k], mid[kr]],
                    [down[kl], down[k], down[kr]],
                );
            }
        }
        std::mem::swap(&mut self.cur, &mut self.next);
    }
}

/// 64マス分の次の世代を論理演算でまとめて求める。
/// 引数はそれぞれ [左隣の語, 中央の語, 右隣の語]。
#[inline(always)]
fn next_word(up: [u64; 3], mid: [u64; 3], down: [u64; 3]) -> u64 {
    let west = |w: [u64; 3]| (w[1] << 1) | (w[0] >> 63);
    let east = |w: [u64; 3]| (w[1] >> 1) | (w[2] << 63);
    let alive = mid[1];

    // 8つの隣のマスの数を、ビットごとに並列な加算器で数える
    let (s1a, c1a) = full_add(west(up), up[1], east(up));
    let (s1b, c1b) = full_add(west(mid), east(mid), west(down));
    let (s1c, c1c) = (down[1] ^ east(down), down[1] & east(down));
    let (ones, c2) = full_add(s1a, s1b, s1c);
    let (t, c3) = full_add(c1a, c1b, c1c);
    let (twos, c4) = (t ^ c2, t & c2);
    let fours = c3 ^ c4; // 8 のときは c3 と c4 が両方立って 0 になるが、8 は死なので問題ない

    // 隣が3なら誕生・生存、2なら生存
    twos & !fours & (ones | alive)
}

#[inline(always)]
fn full_add(a: u64, b: u64, c: u64) -> (u64, u64) {
    let ab = a ^ b;
    (ab ^ c, (a & b) | (c & ab))
}
