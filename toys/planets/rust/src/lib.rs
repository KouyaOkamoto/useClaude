//! 惑星の地形を作る（WebAssembly 版）。
//!
//! 1. ノイズで大陸の形を作る（座標をノイズでゆがめ、山の尾根を重ね、端は海に沈める）
//! 2. 雨粒を大量に落として、斜面を削り、低い所へ土を運ぶ（水による浸食）
//! 3. 高さ・法線・水の流れた量をまとめて返す
//!
//! シードと設定が同じなら、いつも同じ地形になる。

// --- ノイズ ---

struct Perlin {
    p: [u8; 512],
    off: f32,
}

impl Perlin {
    fn new(seed: u32) -> Self {
        let mut perm: [u8; 256] = core::array::from_fn(|i| i as u8);
        let mut s = (seed ^ 0x9e37_79b9) | 1;
        for i in (1..256).rev() {
            s = xorshift(s);
            perm.swap(i, (s % (i as u32 + 1)) as usize);
        }
        Perlin { p: core::array::from_fn(|i| perm[i & 255]), off: (s & 0xffff) as f32 / 97.0 + 0.37 }
    }

    fn noise(&self, x: f32, y: f32) -> f32 {
        let (x, y) = (x + self.off, y + self.off * 0.7);
        let (xi, yi) = (x.floor() as i32 & 255, y.floor() as i32 & 255);
        let (xf, yf) = (x - x.floor(), y - y.floor());
        let (u, v) = (fade(xf), fade(yf));
        let p = &self.p;
        let a = p[xi as usize] as usize + yi as usize;
        let b = p[xi as usize + 1] as usize + yi as usize;
        let lerp = |t: f32, a: f32, b: f32| a + t * (b - a);
        lerp(
            v,
            lerp(u, grad(p[a], xf, yf), grad(p[b], xf - 1.0, yf)),
            lerp(u, grad(p[a + 1], xf, yf - 1.0), grad(p[b + 1], xf - 1.0, yf - 1.0)),
        )
    }

    // 細かさの違うノイズを重ねる。gain が大きいほどゴツゴツする
    fn fbm(&self, x: f32, y: f32, octaves: u32, gain: f32) -> f32 {
        let (mut sum, mut amp, mut freq, mut norm) = (0.0, 1.0, 1.0, 0.0);
        for _ in 0..octaves {
            sum += self.noise(x * freq, y * freq) * amp;
            norm += amp;
            amp *= gain;
            freq *= 2.03;
        }
        sum / norm
    }

    // 尾根: ノイズの絶対値を反転させると、細く切り立った稜線になる（0〜1）
    fn ridged(&self, x: f32, y: f32, octaves: u32) -> f32 {
        let (mut sum, mut amp, mut freq, mut norm, mut prev) = (0.0, 1.0, 1.0, 0.0, 1.0);
        for _ in 0..octaves {
            let r = 1.0 - (self.noise(x * freq, y * freq) * 1.6).abs().min(1.0);
            let r = r * r;
            sum += r * amp * prev;
            norm += amp;
            prev = r;
            amp *= 0.5;
            freq *= 2.1;
        }
        sum / norm
    }
}

fn fade(t: f32) -> f32 {
    t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}

fn grad(h: u8, x: f32, y: f32) -> f32 {
    match h & 7 {
        0 => x + y,
        1 => -x + y,
        2 => x - y,
        3 => -x - y,
        4 => x,
        5 => -x,
        6 => y,
        _ => -y,
    }
}

fn smoothstep(a: f32, b: f32, x: f32) -> f32 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn xorshift(mut s: u32) -> u32 {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    s
}

// --- 地形 ---

pub struct Terrain {
    heights: Vec<f32>, // n×n、メートル
    map: Vec<u8>,      // n×n×4: 法線の x と z、水の流れた量、未使用
}

/// 形の設定:
/// - world: 一辺の長さ (m)
/// - amp: 高さの大きさ (m)
/// - rough: ゴツゴツ具合（0.4〜0.6）
/// - ridge: 山脈の強さ（0〜1）
/// - warp: 地形のゆがみ（0〜1）
/// - terrace: 段丘（テーブル状の台地）の強さ（0〜1）
/// - erosion: 1マスあたりの雨粒の数（0 で浸食なし）
#[allow(clippy::too_many_arguments)]
#[no_mangle]
pub extern "C" fn terrain_generate(
    seed: u32, n: u32, world: f32, amp: f32, rough: f32, ridge: f32, warp: f32, terrace: f32, erosion: f32,
) -> *mut Terrain {
    let n = n as usize;
    let noise = |k: u32| Perlin::new(seed.wrapping_mul(0x9e37_79b1).wrapping_add(k));
    let (base, mount, wx, wz) = (noise(1), noise(2), noise(3), noise(4));
    let mut h = vec![0f32; n * n];
    let feature = world / 3.5; // 大きな起伏の幅 (m)

    for j in 0..n {
        for i in 0..n {
            let u = i as f32 / (n - 1) as f32 - 0.5;
            let v = j as f32 / (n - 1) as f32 - 0.5;
            let (x, z) = (u * world / feature, v * world / feature);
            // 座標そのものをノイズでずらすと、流れるような自然な形になる
            let (px, pz) = (
                x + warp * 0.6 * wx.fbm(x * 0.9, z * 0.9, 4, 0.5),
                z + warp * 0.6 * wz.fbm(x * 0.9 + 3.1, z * 0.9, 4, 0.5),
            );
            let b = base.fbm(px, pz, 7, rough);
            let r = mount.ridged(px * 1.3, pz * 1.3, 5);
            let mut v_h = b * 0.9 + r * ridge * smoothstep(-0.15, 0.3, b) * 0.9;
            if terrace > 0.0 {
                let steps = 7.0;
                let t = v_h * steps;
                let stepped = (t.floor() + smoothstep(0.42, 0.56, t - t.floor())) / steps;
                v_h += (stepped - v_h) * terrace;
            }
            // 中心から離れるほど海の底に沈めて、大陸の外側を自然に終わらせる（海岸線はノイズで崩す）
            let coast = (u * u + v * v).sqrt() + wx.fbm(x * 0.5 + 9.0, z * 0.5, 3, 0.5) * 0.12;
            let edge = smoothstep(0.3, 0.48, coast);
            h[j * n + i] = v_h + (-0.55 - v_h) * edge;
        }
    }

    let mut flow = vec![0f32; n * n];
    if erosion > 0.0 {
        // 浸食の強さが解像度に左右されないよう、1マスあたりの傾きをそろえてから削る
        let k = n as f32 / 256.0;
        for v in h.iter_mut() {
            *v *= k;
        }
        erode(&mut h, n, (erosion * (n * n) as f32) as u32, seed, &mut flow);
        for v in h.iter_mut() {
            *v /= k;
        }
    }

    // メートルに直し、法線と水の流れをまとめる
    for v in h.iter_mut() {
        *v *= amp;
    }
    let cell = world / (n - 1) as f32;
    let mut map = vec![0u8; n * n * 4];
    for j in 0..n {
        for i in 0..n {
            let at = |a: usize, b: usize| h[b.min(n - 1) * n + a.min(n - 1)];
            let (l, r) = (at(i.saturating_sub(1), j), at(i + 1, j));
            let (d, u) = (at(i, j.saturating_sub(1)), at(i, j + 1));
            let (nx, nz) = ((l - r) / (2.0 * cell), (d - u) / (2.0 * cell));
            let len = (nx * nx + 1.0 + nz * nz).sqrt();
            let o = (j * n + i) * 4;
            map[o] = ((nx / len * 0.5 + 0.5) * 255.0) as u8;
            map[o + 1] = ((nz / len * 0.5 + 0.5) * 255.0) as u8;
            map[o + 2] = ((flow[j * n + i] + 1.0).ln() * 45.0).min(255.0) as u8;
            map[o + 3] = 255;
        }
    }
    Box::into_raw(Box::new(Terrain { heights: h, map }))
}

// 雨粒による浸食。粒は坂を転がり、速いほど多くの土を運べる。
// 運べる量より多く持っているか、上り坂になったら土を置いていく
fn erode(h: &mut [f32], n: usize, droplets: u32, seed: u32, flow: &mut [f32]) {
    const INERTIA: f32 = 0.05;
    const CAPACITY: f32 = 4.0;
    const MIN_CAPACITY: f32 = 0.01;
    const DEPOSIT: f32 = 0.3;
    const ERODE: f32 = 0.3;
    const EVAPORATE: f32 = 0.015;
    const GRAVITY: f32 = 4.0;
    const LIFETIME: usize = 40;
    const RADIUS: i32 = 2;

    // 削るときは周りのマスから少しずつ取る
    let mut brush = Vec::new();
    let mut total = 0.0;
    for dy in -RADIUS..=RADIUS {
        for dx in -RADIUS..=RADIUS {
            let d = ((dx * dx + dy * dy) as f32).sqrt();
            if d <= RADIUS as f32 {
                let w = 1.0 - d / (RADIUS as f32 + 0.5);
                brush.push((dx, dy, w));
                total += w;
            }
        }
    }
    for b in brush.iter_mut() {
        b.2 /= total;
    }

    // 位置 (x, y) の高さと傾き（周りの4マスから）
    let sample = |h: &[f32], x: f32, y: f32| {
        let (ix, iy) = (x as usize, y as usize);
        let (fx, fy) = (x - ix as f32, y - iy as f32);
        let i = iy * n + ix;
        let (a, b, c, d) = (h[i], h[i + 1], h[i + n], h[i + n + 1]);
        let gx = (b - a) * (1.0 - fy) + (d - c) * fy;
        let gy = (c - a) * (1.0 - fx) + (d - b) * fx;
        let height = a * (1.0 - fx) * (1.0 - fy) + b * fx * (1.0 - fy) + c * (1.0 - fx) * fy + d * fx * fy;
        (height, gx, gy)
    };

    let mut s = seed | 1;
    let mut rand = || {
        s = xorshift(s);
        s as f32 / 4_294_967_296.0
    };
    let limit = (n - 3) as f32;
    for _ in 0..droplets {
        let (mut x, mut y) = (1.0 + rand() * limit, 1.0 + rand() * limit);
        let (mut dx, mut dy) = (0.0f32, 0.0f32);
        let (mut speed, mut water, mut sediment) = (1.0f32, 1.0f32, 0.0f32);
        for _ in 0..LIFETIME {
            let (ix, iy) = (x as usize, y as usize);
            let (fx, fy) = (x - ix as f32, y - iy as f32);
            let (height, gx, gy) = sample(h, x, y);
            dx = dx * INERTIA - gx * (1.0 - INERTIA);
            dy = dy * INERTIA - gy * (1.0 - INERTIA);
            let len = (dx * dx + dy * dy).sqrt();
            if len < 1e-6 {
                break;
            }
            dx /= len;
            dy /= len;
            x += dx;
            y += dy;
            if x < 1.0 || y < 1.0 || x >= limit || y >= limit {
                break;
            }
            let dh = sample(h, x, y).0 - height;
            let capacity = (-dh * speed * water * CAPACITY).max(MIN_CAPACITY);
            let i = iy * n + ix;
            if sediment > capacity || dh > 0.0 {
                let amount = if dh > 0.0 { dh.min(sediment) } else { (sediment - capacity) * DEPOSIT };
                sediment -= amount;
                h[i] += amount * (1.0 - fx) * (1.0 - fy);
                h[i + 1] += amount * fx * (1.0 - fy);
                h[i + n] += amount * (1.0 - fx) * fy;
                h[i + n + 1] += amount * fx * fy;
            } else {
                let amount = ((capacity - sediment) * ERODE).min(-dh);
                for &(ox, oy, w) in &brush {
                    let (cx, cy) = (ix as i32 + ox, iy as i32 + oy);
                    if cx >= 0 && cy >= 0 && (cx as usize) < n && (cy as usize) < n {
                        h[cy as usize * n + cx as usize] -= amount * w;
                    }
                }
                sediment += amount;
            }
            speed = (speed * speed - dh * GRAVITY).max(0.0).sqrt();
            water *= 1.0 - EVAPORATE;
            flow[i] += water;
        }
    }
}

/// kind: 0 = 高さ (f32)、1 = 法線と水の流れ (u8×4)
///
/// # Safety
/// terrain_generate で作った有効なポインタを渡すこと。
#[no_mangle]
pub unsafe extern "C" fn terrain_ptr(t: *const Terrain, kind: u32) -> *const u8 {
    let t = &*t;
    if kind == 0 { t.heights.as_ptr() as *const u8 } else { t.map.as_ptr() }
}

/// 要素の数（バイト数ではない）
///
/// # Safety
/// terrain_generate で作った有効なポインタを渡すこと。
#[no_mangle]
pub unsafe extern "C" fn terrain_len(t: *const Terrain, kind: u32) -> u32 {
    let t = &*t;
    (if kind == 0 { t.heights.len() } else { t.map.len() }) as u32
}

/// # Safety
/// terrain_generate で作ったポインタを1回だけ渡すこと。
#[no_mangle]
pub unsafe extern "C" fn terrain_free(t: *mut Terrain) {
    drop(Box::from_raw(t));
}
