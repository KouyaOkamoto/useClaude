//! ボクセル世界の生成（WebAssembly 版）。
//!
//! シードとチャンク座標から、16×16×128 ブロックのチャンクを作り、描画用の頂点まで組み立てる。
//! 同じシード・同じ座標なら必ず同じ結果になるので、世界を保存しなくても何度でも作り直せる。
//!
//! 面を出すかどうかには隣のブロックが要るので、周囲1ブロックを含めた 18×18 の範囲を作ってから、
//! 内側の 16×16 だけを頂点にする。木は隣のチャンクからはみ出してくる分も、ここで同じように植える。

use std::cell::RefCell;

const CS: i32 = 16; // チャンクの幅
const H: i32 = 128; // 世界の高さ
const P: i32 = CS + 2; // 周囲1ブロックを含めた幅
const SEA: i32 = 48; // 海面の高さ

// ブロック
const AIR: u8 = 0;
const GRASS: u8 = 1;
const DIRT: u8 = 2;
const STONE: u8 = 3;
const SAND: u8 = 4;
const WATER: u8 = 5;
const SNOW: u8 = 6;
const LOG: u8 = 7;
const LEAVES: u8 = 8;
const CACTUS: u8 = 9;
const SANDSTONE: u8 = 10;
const GRAVEL: u8 = 11;
const NEEDLES: u8 = 12;
const COAL: u8 = 13;

// バイオーム
const OCEAN: u8 = 0;
const BEACH: u8 = 1;
const PLAINS: u8 = 2;
const FOREST: u8 = 3;
const DESERT: u8 = 4;
const SNOWY: u8 = 5;
const MOUNTAIN: u8 = 6;

// ブロックの色 [上面, 側面, 下面]
const COLORS: [[[u8; 3]; 3]; 14] = [
    [[0, 0, 0]; 3],
    [[106, 170, 68], [120, 116, 64], [121, 85, 58]],
    [[121, 85, 58]; 3],
    [[125, 125, 125]; 3],
    [[219, 205, 150]; 3],
    [[52, 110, 200]; 3],
    [[240, 244, 250], [214, 220, 228], [121, 85, 58]],
    [[150, 118, 72], [102, 78, 48], [150, 118, 72]],
    [[62, 128, 48]; 3],
    [[86, 140, 60], [72, 124, 50], [86, 140, 60]],
    [[214, 196, 140], [200, 180, 124], [214, 196, 140]],
    [[136, 128, 122]; 3],
    [[44, 92, 62]; 3],
    [[90, 90, 92]; 3],
];

// --- ノイズ ---

struct Perlin {
    p: [u8; 512],
    off: f32, // シードごとにずらす（格子点ではノイズが必ず 0 になるのを避ける）
}

impl Perlin {
    fn new(seed: u32) -> Self {
        let mut perm: [u8; 256] = core::array::from_fn(|i| i as u8);
        let mut s = (seed ^ 0x9e37_79b9) | 1;
        for i in (1..256).rev() {
            s ^= s << 13;
            s ^= s >> 17;
            s ^= s << 5;
            perm.swap(i, (s % (i as u32 + 1)) as usize);
        }
        Perlin { p: core::array::from_fn(|i| perm[i & 255]), off: (s & 0xffff) as f32 / 97.0 + 0.37 }
    }

    fn noise2(&self, x: f32, y: f32) -> f32 {
        let (x, y) = (x + self.off, y + self.off * 0.7);
        let (xi, yi) = (x.floor() as i32 & 255, y.floor() as i32 & 255);
        let (xf, yf) = (x - x.floor(), y - y.floor());
        let (u, v) = (fade(xf), fade(yf));
        let p = &self.p;
        let a = p[xi as usize] as usize + yi as usize;
        let b = p[xi as usize + 1] as usize + yi as usize;
        lerp(
            v,
            lerp(u, grad2(p[a], xf, yf), grad2(p[b], xf - 1.0, yf)),
            lerp(u, grad2(p[a + 1], xf, yf - 1.0), grad2(p[b + 1], xf - 1.0, yf - 1.0)),
        )
    }

    fn noise3(&self, x: f32, y: f32, z: f32) -> f32 {
        let (x, y, z) = (x + self.off, y + self.off * 0.7, z + self.off * 1.3);
        let (xi, yi, zi) = (x.floor() as i32 & 255, y.floor() as i32 & 255, z.floor() as i32 & 255);
        let (xf, yf, zf) = (x - x.floor(), y - y.floor(), z - z.floor());
        let (u, v, w) = (fade(xf), fade(yf), fade(zf));
        let p = &self.p;
        let a = p[xi as usize] as usize + yi as usize;
        let aa = p[a] as usize + zi as usize;
        let ab = p[a + 1] as usize + zi as usize;
        let b = p[xi as usize + 1] as usize + yi as usize;
        let ba = p[b] as usize + zi as usize;
        let bb = p[b + 1] as usize + zi as usize;
        lerp(
            w,
            lerp(
                v,
                lerp(u, grad3(p[aa], xf, yf, zf), grad3(p[ba], xf - 1.0, yf, zf)),
                lerp(u, grad3(p[ab], xf, yf - 1.0, zf), grad3(p[bb], xf - 1.0, yf - 1.0, zf)),
            ),
            lerp(
                v,
                lerp(u, grad3(p[aa + 1], xf, yf, zf - 1.0), grad3(p[ba + 1], xf - 1.0, yf, zf - 1.0)),
                lerp(u, grad3(p[ab + 1], xf, yf - 1.0, zf - 1.0), grad3(p[bb + 1], xf - 1.0, yf - 1.0, zf - 1.0)),
            ),
        )
    }

    // 細かさの違うノイズを重ねる（-1〜1 程度）
    fn fbm2(&self, x: f32, y: f32, octaves: u32) -> f32 {
        let (mut sum, mut amp, mut freq, mut norm) = (0.0, 1.0, 1.0, 0.0);
        for _ in 0..octaves {
            sum += self.noise2(x * freq, y * freq) * amp;
            norm += amp;
            amp *= 0.5;
            freq *= 2.0;
        }
        sum / norm
    }
}

fn fade(t: f32) -> f32 {
    t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}

fn lerp(t: f32, a: f32, b: f32) -> f32 {
    a + t * (b - a)
}

fn grad2(h: u8, x: f32, y: f32) -> f32 {
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

fn grad3(h: u8, x: f32, y: f32, z: f32) -> f32 {
    let h = h & 15;
    let u = if h < 8 { x } else { y };
    let v = if h < 4 {
        y
    } else if h == 12 || h == 14 {
        x
    } else {
        z
    };
    (if h & 1 == 0 { u } else { -u }) + (if h & 2 == 0 { v } else { -v })
}

fn smoothstep(a: f32, b: f32, x: f32) -> f32 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

// 座標から決まる乱数
fn hash(seed: u32, x: i32, y: i32, z: i32) -> u32 {
    let mut h = seed
        ^ (x as u32).wrapping_mul(0x27d4_eb2d)
        ^ (y as u32).wrapping_mul(0x1656_67b1)
        ^ (z as u32).wrapping_mul(0x9e37_79b1);
    h ^= h >> 15;
    h = h.wrapping_mul(0x85eb_ca6b);
    h ^= h >> 13;
    h = h.wrapping_mul(0xc2b2_ae35);
    h ^ (h >> 16)
}

fn hashf(seed: u32, x: i32, y: i32, z: i32) -> f32 {
    hash(seed, x, y, z) as f32 / 4_294_967_296.0
}

// --- 地形 ---

struct Gen {
    seed: u32,
    continent: Perlin,
    mountain: Perlin,
    detail: Perlin,
    temperature: Perlin,
    humidity: Perlin,
    cave_a: Perlin,
    cave_b: Perlin,
}

impl Gen {
    fn new(seed: u32) -> Self {
        let n = |k: u32| Perlin::new(seed.wrapping_mul(0x9e37_79b1).wrapping_add(k));
        Gen {
            seed,
            continent: n(1),
            mountain: n(2),
            detail: n(3),
            temperature: n(4),
            humidity: n(5),
            cave_a: n(6),
            cave_b: n(7),
        }
    }

    // その地点の地面の高さとバイオーム
    fn column(&self, x: i32, z: i32) -> (i32, u8) {
        let (fx, fz) = (x as f32, z as f32);
        let cont = self.continent.fbm2(fx / 700.0, fz / 700.0, 4);
        let ridge = (1.0 - self.mountain.fbm2(fx / 260.0, fz / 260.0, 4).abs() * 1.6).max(0.0);
        let detail = self.detail.fbm2(fx / 48.0, fz / 48.0, 3);
        let m = smoothstep(0.05, 0.4, cont);
        let mut h = SEA as f32 + 6.0 + cont * 50.0;
        h += ridge * ridge * 60.0 * m;
        h += detail * (3.0 + 7.0 * m);
        let h = (h as i32).clamp(6, H - 24);

        let temp = self.temperature.fbm2(fx / 900.0, fz / 900.0, 2) - (h - SEA).max(0) as f32 * 0.008;
        let humid = self.humidity.fbm2(fx / 800.0 + 50.0, fz / 800.0, 2);
        let biome = if h < SEA - 1 {
            OCEAN
        } else if h <= SEA + 1 {
            BEACH
        } else if h > SEA + 34 {
            MOUNTAIN
        } else if temp < -0.18 {
            SNOWY
        } else if temp > 0.15 && humid < 0.0 {
            DESERT
        } else if humid > 0.0 {
            FOREST
        } else {
            PLAINS
        };
        (h, biome)
    }

    fn block(&self, wx: i32, y: i32, wz: i32, h: i32, biome: u8) -> u8 {
        if y > h {
            return if y <= SEA { WATER } else { AIR };
        }
        let b = if y == h {
            match biome {
                OCEAN => if h < SEA - 6 { GRAVEL } else { SAND },
                BEACH | DESERT => SAND,
                SNOWY => SNOW,
                MOUNTAIN => if h > SEA + 55 { SNOW } else { STONE },
                _ => GRASS,
            }
        } else if y > h - 4 {
            match biome {
                OCEAN | BEACH | DESERT => SAND,
                MOUNTAIN => STONE,
                _ => DIRT,
            }
        } else if biome == DESERT && y > h - 9 {
            SANDSTONE
        } else if y < h - 6 && hashf(self.seed, wx, y, wz) < 0.012 {
            COAL
        } else {
            STONE
        };
        // 洞窟: 2つのノイズがともに 0 に近い所をつなげると、曲がりくねったトンネルになる
        let shallow_wet = h <= SEA + 1 && y > h - 5;
        if y >= 3 && !shallow_wet {
            let (fx, fy, fz) = (wx as f32 / 22.0, y as f32 / 14.0, wz as f32 / 22.0);
            let a = self.cave_a.noise3(fx, fy, fz);
            let c = self.cave_b.noise3(fx, fy, fz);
            if a * a + c * c < 0.009 {
                return AIR;
            }
        }
        b
    }
}

thread_local! {
    static GEN: RefCell<Option<Gen>> = const { RefCell::new(None) };
}

fn with_gen<T>(seed: u32, f: impl FnOnce(&Gen) -> T) -> T {
    GEN.with(|g| {
        let mut g = g.borrow_mut();
        if g.as_ref().map(|g| g.seed) != Some(seed) {
            *g = Some(Gen::new(seed));
        }
        f(g.as_ref().unwrap())
    })
}

// --- チャンク ---

#[derive(Default)]
struct Mesh {
    pos: Vec<f32>,
    col: Vec<u8>,
    idx: Vec<u32>,
}

pub struct Chunk {
    solid: Mesh,
    water: Mesh,
    blocks: Vec<u8>, // 内側 16×16×128、並びは (y*16 + z)*16 + x
    biomes: Vec<u8>, // 内側 16×16、並びは z*16 + x
}

struct Volume {
    v: Vec<u8>,
}

impl Volume {
    fn get(&self, x: i32, y: i32, z: i32) -> u8 {
        if y < 0 {
            STONE
        } else if y >= H || x < 0 || z < 0 || x >= P || z >= P {
            AIR
        } else {
            self.v[((y * P + z) * P + x) as usize]
        }
    }

    // 空き（または葉）の所にだけ置く。範囲外は無視
    fn put(&mut self, x: i32, y: i32, z: i32, b: u8) {
        if x < 0 || z < 0 || x >= P || z >= P || !(0..H).contains(&y) {
            return;
        }
        let i = ((y * P + z) * P + x) as usize;
        let cur = self.v[i];
        if cur == AIR || (cur == WATER && b != LEAVES && b != NEEDLES) || ((cur == LEAVES || cur == NEEDLES) && b == LOG) {
            self.v[i] = b;
        }
    }
}

fn generate(seed: u32, cx: i32, cz: i32) -> Chunk {
    with_gen(seed, |gen| {
        let (ox, oz) = (cx * CS - 1, cz * CS - 1); // 周囲を含めた範囲の端の世界座標
        let mut vol = Volume { v: vec![AIR; (P * P * H) as usize] };
        let mut biomes = vec![0u8; (CS * CS) as usize];
        for z in 0..P {
            for x in 0..P {
                let (wx, wz) = (ox + x, oz + z);
                let (h, biome) = gen.column(wx, wz);
                if (1..=CS).contains(&x) && (1..=CS).contains(&z) {
                    biomes[((z - 1) * CS + x - 1) as usize] = biome;
                }
                for y in 0..H.min(h.max(SEA) + 1) {
                    vol.v[((y * P + z) * P + x) as usize] = gen.block(wx, y, wz, h, biome);
                }
            }
        }
        plant_trees(gen, &mut vol, ox, oz);

        let mut blocks = vec![AIR; (CS * CS * H) as usize];
        for y in 0..H {
            for z in 0..CS {
                for x in 0..CS {
                    blocks[((y * CS + z) * CS + x) as usize] = vol.get(x + 1, y, z + 1);
                }
            }
        }
        let (solid, water) = build_mesh(&vol, seed, ox, oz);
        Chunk { solid, water, blocks, biomes }
    })
}

// 5×5 マスごとに1か所だけ候補を作り、バイオームに応じた確率で木を植える
fn plant_trees(gen: &Gen, vol: &mut Volume, ox: i32, oz: i32) {
    const CELL: i32 = 5;
    const REACH: i32 = 3; // 木が横に広がる最大の幅
    let seed = gen.seed;
    let (gx0, gz0) = ((ox - REACH).div_euclid(CELL), (oz - REACH).div_euclid(CELL));
    let (gx1, gz1) = ((ox + P + REACH).div_euclid(CELL), (oz + P + REACH).div_euclid(CELL));
    for gz in gz0..=gz1 {
        for gx in gx0..=gx1 {
            let wx = gx * CELL + (hash(seed, gx, 1, gz) % CELL as u32) as i32;
            let wz = gz * CELL + (hash(seed, gx, 2, gz) % CELL as u32) as i32;
            let (h, biome) = gen.column(wx, wz);
            let density = match biome {
                FOREST => 0.8,
                PLAINS => 0.1,
                SNOWY => 0.45,
                DESERT => 0.12,
                MOUNTAIN if h < SEA + 52 => 0.15,
                _ => 0.0,
            };
            if h <= SEA || hashf(seed, gx, 3, gz) >= density {
                continue;
            }
            let (lx, base, lz) = (wx - ox, h + 1, wz - oz);
            let r = hash(seed, gx, 4, gz);
            match biome {
                DESERT => {
                    for y in base..base + 2 + (r % 3) as i32 {
                        vol.put(lx, y, lz, CACTUS);
                    }
                }
                SNOWY | MOUNTAIN => {
                    let top = base + 5 + (r % 3) as i32;
                    for y in base + 2..=top + 1 {
                        let rad = if y == top + 1 { 0 } else { ((top - y) / 2 + 1).min(2) };
                        for dz in -rad..=rad {
                            for dx in -rad..=rad {
                                if rad == 2 && dx.abs() == 2 && dz.abs() == 2 {
                                    continue;
                                }
                                vol.put(lx + dx, y, lz + dz, NEEDLES);
                            }
                        }
                    }
                    for y in base..=top {
                        vol.put(lx, y, lz, LOG);
                    }
                }
                _ => {
                    let top = base + 3 + (r % 3) as i32;
                    for dy in -2..=1 {
                        let rad: i32 = if dy >= 0 { 1 } else { 2 };
                        for dz in -rad..=rad {
                            for dx in -rad..=rad {
                                let corner = dx.abs() == rad && dz.abs() == rad;
                                if corner && (dy == 1 || hashf(seed, wx + dx, top + dy, wz + dz) < 0.6) {
                                    continue;
                                }
                                vol.put(lx + dx, top + dy, lz + dz, LEAVES);
                            }
                        }
                    }
                    for y in base..=top {
                        vol.put(lx, y, lz, LOG);
                    }
                }
            }
        }
    }
}

// --- 頂点の組み立て ---

// 面ごとの法線と、外から見て反時計回りの4頂点
const FACES: [([i32; 3], [[i32; 3]; 4]); 6] = [
    ([1, 0, 0], [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]]),
    ([-1, 0, 0], [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]]),
    ([0, 1, 0], [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]]),
    ([0, -1, 0], [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]]),
    ([0, 0, 1], [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]]),
    ([0, 0, -1], [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]]),
];
const FACE_SHADE: [f32; 6] = [0.8, 0.8, 1.0, 0.55, 0.68, 0.68];
const AO_SHADE: [f32; 4] = [0.5, 0.67, 0.83, 1.0];

const fn opaque(b: u8) -> bool {
    b != AIR && b != WATER
}

fn build_mesh(vol: &Volume, seed: u32, ox: i32, oz: i32) -> (Mesh, Mesh) {
    let mut solid = Mesh::default();
    let mut water = Mesh::default();
    for y in 0..H {
        for z in 1..=CS {
            for x in 1..=CS {
                let b = vol.get(x, y, z);
                if b == AIR {
                    continue;
                }
                for (f, (n, corners)) in FACES.iter().enumerate() {
                    let nb = vol.get(x + n[0], y + n[1], z + n[2]);
                    if b == WATER {
                        // 水は空気に接する上と横の面だけ
                        if nb == AIR && n[1] >= 0 {
                            push_water(&mut water, x - 1, y, z - 1, corners, FACE_SHADE[f]);
                        }
                        continue;
                    }
                    if opaque(nb) {
                        continue;
                    }
                    // 頂点ごとの影: 面の外側の層で、その角に接する3ブロックの埋まり具合
                    let mut ao = [3u8; 4];
                    for (k, c) in corners.iter().enumerate() {
                        let mut t = [0i32; 3];
                        let mut side = [[0i32; 3]; 2];
                        let mut s = 0;
                        for axis in 0..3 {
                            if n[axis] == 0 {
                                t[axis] = if c[axis] == 1 { 1 } else { -1 };
                                side[s][axis] = t[axis];
                                s += 1;
                            }
                        }
                        let at = |d: [i32; 3]| opaque(vol.get(x + n[0] + d[0], y + n[1] + d[1], z + n[2] + d[2])) as u8;
                        let (s1, s2, corner) = (at(side[0]), at(side[1]), at(t));
                        ao[k] = if s1 == 1 && s2 == 1 { 0 } else { 3 - s1 - s2 - corner };
                    }
                    let kind = if n[1] > 0 { 0 } else if n[1] < 0 { 2 } else { 1 };
                    let base = COLORS[b as usize][kind];
                    let vary = 0.92 + 0.08 * hashf(seed, ox + x, y, oz + z);
                    let start = (solid.pos.len() / 3) as u32;
                    for (k, c) in corners.iter().enumerate() {
                        solid.pos.extend([(x - 1 + c[0]) as f32, (y + c[1]) as f32, (z - 1 + c[2]) as f32]);
                        let shade = FACE_SHADE[f] * AO_SHADE[ao[k] as usize] * vary;
                        solid.col.extend(base.map(|v| (v as f32 * shade).min(255.0) as u8));
                    }
                    // 影の付き方で対角線の向きを変えると、角の暗さが自然になる
                    if ao[0] as u32 + ao[2] as u32 > ao[1] as u32 + ao[3] as u32 {
                        solid.idx.extend([start, start + 1, start + 2, start, start + 2, start + 3]);
                    } else {
                        solid.idx.extend([start + 1, start + 2, start + 3, start + 1, start + 3, start]);
                    }
                }
            }
        }
    }
    (solid, water)
}

fn push_water(m: &mut Mesh, x: i32, y: i32, z: i32, corners: &[[i32; 3]; 4], shade: f32) {
    let start = (m.pos.len() / 3) as u32;
    for c in corners {
        // 水面は少し下げる
        let top = if c[1] == 1 { 0.88 } else { 0.0 };
        m.pos.extend([(x + c[0]) as f32, y as f32 + top, (z + c[2]) as f32]);
        m.col.extend(COLORS[WATER as usize][0].map(|v| (v as f32 * shade) as u8));
    }
    m.idx.extend([start, start + 1, start + 2, start, start + 2, start + 3]);
}

// --- JS から呼ぶ関数 ---

#[no_mangle]
pub extern "C" fn chunk_generate(seed: u32, cx: i32, cz: i32) -> *mut Chunk {
    Box::into_raw(Box::new(generate(seed, cx, cz)))
}

/// kind: 0〜2 = 地面の位置・色・番号、3〜5 = 水の位置・色・番号、6 = ブロック、7 = バイオーム
///
/// # Safety
/// chunk_generate で作った有効なポインタを渡すこと。
#[no_mangle]
pub unsafe extern "C" fn chunk_ptr(chunk: *const Chunk, kind: u32) -> *const u8 {
    let c = &*chunk;
    match kind {
        0 => c.solid.pos.as_ptr() as *const u8,
        1 => c.solid.col.as_ptr(),
        2 => c.solid.idx.as_ptr() as *const u8,
        3 => c.water.pos.as_ptr() as *const u8,
        4 => c.water.col.as_ptr(),
        5 => c.water.idx.as_ptr() as *const u8,
        6 => c.blocks.as_ptr(),
        _ => c.biomes.as_ptr(),
    }
}

/// 要素の数（バイト数ではない）
///
/// # Safety
/// chunk_generate で作った有効なポインタを渡すこと。
#[no_mangle]
pub unsafe extern "C" fn chunk_len(chunk: *const Chunk, kind: u32) -> u32 {
    let c = &*chunk;
    (match kind {
        0 => c.solid.pos.len(),
        1 => c.solid.col.len(),
        2 => c.solid.idx.len(),
        3 => c.water.pos.len(),
        4 => c.water.col.len(),
        5 => c.water.idx.len(),
        6 => c.blocks.len(),
        _ => c.biomes.len(),
    }) as u32
}

/// # Safety
/// chunk_generate で作ったポインタを1回だけ渡すこと。
#[no_mangle]
pub unsafe extern "C" fn chunk_free(chunk: *mut Chunk) {
    drop(Box::from_raw(chunk));
}

/// 原点の近くで、海でも浜でもない陸地を探す。x と z を 16 ビットずつ詰めて返す
#[no_mangle]
pub extern "C" fn find_spawn(seed: u32) -> u32 {
    with_gen(seed, |gen| {
        for ring in 0..200 {
            for i in 0..(ring * 8).max(1) {
                let a = i as f32 / (ring * 8).max(1) as f32 * std::f32::consts::TAU;
                let (x, z) = ((a.cos() * ring as f32 * 16.0) as i32, (a.sin() * ring as f32 * 16.0) as i32);
                let (h, biome) = gen.column(x, z);
                if biome != OCEAN && biome != BEACH && h < SEA + 30 {
                    return ((x as i16 as u16 as u32) << 16) | (z as i16 as u16 as u32);
                }
            }
        }
        0
    })
}
