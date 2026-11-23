/*
 * astro.js — 暦（ユリウス日）・ΔT・惑星位置の計算
 *
 * 惑星位置は NASA JPL の
 *   "Keplerian Elements for Approximate Positions of the Major Planets" (E. M. Standish)
 * の Table 2a（紀元前3000年〜西暦3000年用）と Table 2b（木星〜海王星の補正項）を使う。
 * 座標系は J2000.0 黄道座標（日心、単位 au）。
 *
 * アプリで扱う期間（紀元前3000年1月1日〜西暦3000年12月31日）は、この表の対象期間と同じにしてある。
 * 表の外側へ延長すると精度が下がるため、範囲を広げるときは別の理論（VSOP87 など）を検討すること。
 */
(function (root) {
  'use strict';

  const DEG = Math.PI / 180;
  const J2000 = 2451545.0;
  const AU_KM = 149597870.7;
  const OBLIQUITY = 23.4392911 * DEG; // J2000 の黄道傾斜角

  const mod = (a, n) => ((a % n) + n) % n;

  /* ---------------------------------------------------------------------------
   * 暦
   *   1582年10月15日以降はグレゴリオ暦、それより前はユリウス暦（JPL Horizons と同じ）。
   *   年は天文学的年号: 紀元前1年 = 0年、紀元前3000年 = -2999年。
   * ------------------------------------------------------------------------- */
  const GREGORIAN_START_JD = 2299160.5; // 1582-10-15 00:00 UT

  function isGregorianDate(y, m, d) {
    return y > 1582 || (y === 1582 && (m > 10 || (m === 10 && d >= 15)));
  }

  function isLeapYear(y) {
    if (y > 1582) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    return mod(y, 4) === 0; // ユリウス暦（紀元前1年=0年, 紀元前5年=-4年 … もうるう年）
  }

  function daysInMonth(y, m) {
    const table = [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return table[m - 1];
  }

  /** 年月日（d は小数可）→ ユリウス日 */
  function jdFromCalendar(y, m, d) {
    let Y = y, M = m;
    if (M <= 2) { Y -= 1; M += 12; }
    let B = 0;
    if (isGregorianDate(y, m, Math.floor(d))) {
      const A = Math.floor(Y / 100);
      B = 2 - A + Math.floor(A / 4);
    }
    // Math.floor を使うので負の年でもユリウス暦の4年周期が正しく扱える
    return Math.floor(365.25 * (Y + 4716)) + Math.floor(30.6001 * (M + 1)) + d + B - 1524.5;
  }

  /** ユリウス日 → 年月日（＋時刻） */
  function calendarFromJD(jd) {
    const jj = jd + 0.5;
    let Z = Math.floor(jj);
    const F = jj - Z;
    let shiftYears = 0;
    let A;
    if (Z < 2299161) {
      // ユリウス暦。負のユリウス日は 4年 = 1461日 単位で正の範囲へずらして計算する
      if (Z < 0) {
        const n = Math.ceil(-Z / 1461) + 1;
        Z += n * 1461;
        shiftYears = 4 * n;
      }
      A = Z;
    } else {
      const alpha = Math.floor((Z - 1867216.25) / 36524.25);
      A = Z + 1 + alpha - Math.floor(alpha / 4);
    }
    const B = A + 1524;
    const C = Math.floor((B - 122.1) / 365.25);
    const D = Math.floor(365.25 * C);
    const E = Math.floor((B - D) / 30.6001);
    const dayF = B - D - Math.floor(30.6001 * E) + F;
    const month = E < 14 ? E - 1 : E - 13;
    const year = (month > 2 ? C - 4716 : C - 4715) - shiftYears;
    const day = Math.floor(dayF);
    const fraction = dayF - day;
    return { year, month, day, fraction, gregorian: jd >= GREGORIAN_START_JD };
  }

  /** 現在時刻のユリウス日（UT） */
  function jdNow() {
    return Date.now() / 86400000 + 2440587.5;
  }

  /* ---------------------------------------------------------------------------
   * ΔT = TT − UT（秒）。Espenak & Meeus (NASA Five Millennium Canon) の多項式。
   * 惑星の位置は TT で計算するため、表示している日時（UT）に ΔT を足す。
   * 紀元前3000年付近では ΔT は約0.9日になり、水星の位置で数度の差になる。
   * ------------------------------------------------------------------------- */
  function deltaTSeconds(y) {
    let u, t;
    if (y < -500) {
      u = (y - 1820) / 100;
      return -20 + 32 * u * u;
    }
    if (y < 500) {
      u = y / 100;
      return 10583.6 - 1014.41 * u + 33.78311 * u ** 2 - 5.952053 * u ** 3
        - 0.1798452 * u ** 4 + 0.022174192 * u ** 5 + 0.0090316521 * u ** 6;
    }
    if (y < 1600) {
      u = (y - 1000) / 100;
      return 1574.2 - 556.01 * u + 71.23472 * u ** 2 + 0.319781 * u ** 3
        - 0.8503463 * u ** 4 - 0.005050998 * u ** 5 + 0.0083572073 * u ** 6;
    }
    if (y < 1700) {
      t = y - 1600;
      return 120 - 0.9808 * t - 0.01532 * t ** 2 + t ** 3 / 7129;
    }
    if (y < 1800) {
      t = y - 1700;
      return 8.83 + 0.1603 * t - 0.0059285 * t ** 2 + 0.00013336 * t ** 3 - t ** 4 / 1174000;
    }
    if (y < 1860) {
      t = y - 1800;
      return 13.72 - 0.332447 * t + 0.0068612 * t ** 2 + 0.0041116 * t ** 3 - 0.00037436 * t ** 4
        + 0.0000121272 * t ** 5 - 0.0000001699 * t ** 6 + 0.000000000875 * t ** 7;
    }
    if (y < 1900) {
      t = y - 1860;
      return 7.62 + 0.5737 * t - 0.251754 * t ** 2 + 0.01680668 * t ** 3
        - 0.0004473624 * t ** 4 + t ** 5 / 233174;
    }
    if (y < 1920) {
      t = y - 1900;
      return -2.79 + 1.494119 * t - 0.0598939 * t ** 2 + 0.0061966 * t ** 3 - 0.000197 * t ** 4;
    }
    if (y < 1941) {
      t = y - 1920;
      return 21.20 + 0.84493 * t - 0.076100 * t ** 2 + 0.0020936 * t ** 3;
    }
    if (y < 1961) {
      t = y - 1950;
      return 29.07 + 0.407 * t - t ** 2 / 233 + t ** 3 / 2547;
    }
    if (y < 1986) {
      t = y - 1975;
      return 45.45 + 1.067 * t - t ** 2 / 260 - t ** 3 / 718;
    }
    if (y < 2005) {
      t = y - 2000;
      return 63.86 + 0.3345 * t - 0.060374 * t ** 2 + 0.0017275 * t ** 3
        + 0.000651814 * t ** 4 + 0.00002373599 * t ** 5;
    }
    if (y < 2050) {
      t = y - 2000;
      return 62.92 + 0.32217 * t + 0.005589 * t ** 2;
    }
    if (y < 2150) {
      u = (y - 1820) / 100;
      return -20 + 32 * u * u - 0.5628 * (2150 - y);
    }
    u = (y - 1820) / 100;
    return -20 + 32 * u * u;
  }

  /** UT のユリウス日 → J2000.0 からのユリウス世紀数（TT） */
  function centuriesTT(jdUT) {
    const decYear = 2000 + (jdUT - J2000) / 365.2425;
    const jdTT = jdUT + deltaTSeconds(decYear) / 86400;
    return (jdTT - J2000) / 36525;
  }

  /* ---------------------------------------------------------------------------
   * 惑星データ
   *   el: [a, a', e, e', I, I', L, L', ϖ, ϖ', Ω, Ω']（JPL Table 2a, 角度は度, 変化率は /世紀）
   *   extra: [b, c, s, f]（JPL Table 2b）
   *   radiusKm: 赤道半径, flattening: 扁平率
   *   pole: 自転軸の北極（J2000 赤道座標の赤経・赤緯, 度。IAU）
   *   rotation: 自転周期（日、負は逆行自転）
   * ------------------------------------------------------------------------- */
  const PLANETS = [
    {
      key: 'mercury', name: 'Mercury', jp: '水星', color: '#b9b3ab',
      radiusKm: 2440.53, flattening: 0.0009, pole: [281.0103, 61.4155], rotation: 58.6462, ring: 0,
      el: [0.38709843, 0.00000000, 0.20563661, 0.00002123, 7.00559432, -0.00590158,
        252.25166724, 149472.67486623, 77.45771895, 0.15940013, 48.33961819, -0.12214182],
      extra: null,
    },
    {
      key: 'venus', name: 'Venus', jp: '金星', color: '#e9d6a4',
      radiusKm: 6051.8, flattening: 0, pole: [272.76, 67.16], rotation: -243.0185, ring: 0,
      el: [0.72332102, -0.00000026, 0.00676399, -0.00005107, 3.39777545, 0.00043494,
        181.97970850, 58517.81560260, 131.76755713, 0.05679648, 76.67261496, -0.27274174],
      extra: null,
    },
    {
      // JPL の値は地球と月の重心（EM Bary）。地球中心との差は約4,700kmで表示上は無視できる
      key: 'earth', name: 'Earth', jp: '地球', color: '#5b93e6',
      radiusKm: 6378.137, flattening: 0.00335, pole: [0, 90], rotation: 0.99726968, ring: 0,
      el: [1.00000018, -0.00000003, 0.01673163, -0.00003661, -0.00054346, -0.01337178,
        100.46691572, 35999.37306329, 102.93005885, 0.31795260, -5.11260389, -0.24123856],
      extra: null,
    },
    {
      key: 'mars', name: 'Mars', jp: '火星', color: '#d0603a',
      radiusKm: 3396.19, flattening: 0.00589, pole: [317.68143, 52.88650], rotation: 1.02595676, ring: 0,
      el: [1.52371243, 0.00000097, 0.09336511, 0.00009149, 1.85181869, -0.00724757,
        -4.56813164, 19140.29934243, -23.91744784, 0.45223625, 49.71320984, -0.26852431],
      extra: null,
    },
    {
      key: 'jupiter', name: 'Jupiter', jp: '木星', color: '#d8b48e',
      radiusKm: 71492, flattening: 0.06487, pole: [268.056595, 64.495303], rotation: 0.41354, ring: 3,
      el: [5.20248019, -0.00002864, 0.04853590, 0.00018026, 1.29861416, -0.00322699,
        34.33479152, 3034.90371757, 14.27495244, 0.18199196, 100.29282654, 0.13024619],
      extra: [-0.00012452, 0.06064060, -0.35635438, 38.35125000],
    },
    {
      key: 'saturn', name: 'Saturn', jp: '土星', color: '#e5cf98',
      radiusKm: 60268, flattening: 0.09796, pole: [40.589, 83.537], rotation: 0.44401, ring: 1,
      el: [9.54149883, -0.00003065, 0.05550825, -0.00032044, 2.49424102, 0.00451969,
        50.07571329, 1222.11494724, 92.86136063, 0.54179478, 113.63998702, -0.25015002],
      extra: [0.00025899, -0.13434469, 0.87320147, 38.35125000],
    },
    {
      key: 'uranus', name: 'Uranus', jp: '天王星', color: '#9fd8de',
      radiusKm: 25559, flattening: 0.02293, pole: [257.311, -15.175], rotation: -0.71833, ring: 2,
      el: [19.18797948, -0.00020455, 0.04685740, -0.00001550, 0.77298127, -0.00180155,
        314.20276625, 428.49512595, 172.43404441, 0.09266985, 73.96250215, 0.05739699],
      extra: [0.00058331, -0.97731848, 0.17689245, 7.67025000],
    },
    {
      key: 'neptune', name: 'Neptune', jp: '海王星', color: '#5179e0',
      radiusKm: 24764, flattening: 0.01708, pole: [299.36, 43.46], rotation: 0.67125, ring: 4,
      el: [30.06952752, 0.00006447, 0.00895439, 0.00000818, 1.77005520, 0.00022400,
        304.22289287, 218.46515314, 46.68158724, 0.01009938, 131.78635853, -0.00606302],
      extra: [-0.00041348, 0.68346318, -0.10162547, 7.67025000],
    },
  ];

  const SUN = { name: 'Sun', jp: '太陽', radiusKm: 695700, pole: [286.13, 63.87], rotation: 25.38 };

  /** 赤道座標の単位ベクトル → 黄道座標（J2000） */
  function equatorialToEcliptic(v) {
    const c = Math.cos(OBLIQUITY), s = Math.sin(OBLIQUITY);
    return [v[0], v[1] * c + v[2] * s, -v[1] * s + v[2] * c];
  }

  function raDecToEcliptic(raDeg, decDeg) {
    const ra = raDeg * DEG, dec = decDeg * DEG;
    return equatorialToEcliptic([Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)]);
  }

  for (const p of PLANETS) p.poleEcl = raDecToEcliptic(p.pole[0], p.pole[1]);
  SUN.poleEcl = raDecToEcliptic(SUN.pole[0], SUN.pole[1]);

  /* ---------------------------------------------------------------------------
   * 軌道計算
   * ------------------------------------------------------------------------- */
  function solveKepler(M, e) {
    let E = M + e * Math.sin(M) * (1 + e * Math.cos(M));
    for (let i = 0; i < 12; i++) {
      const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
      E -= dE;
      if (Math.abs(dE) < 1e-13) break;
    }
    return E;
  }

  /** 時刻 T（J2000.0 からのユリウス世紀, TT）における軌道要素 */
  function orbitAt(p, T) {
    const el = p.el;
    const a = el[0] + el[1] * T;
    const e = el[2] + el[3] * T;
    const I = (el[4] + el[5] * T) * DEG;
    const L = el[6] + el[7] * T;
    const wbar = el[8] + el[9] * T;
    const node = el[10] + el[11] * T;
    let Mdeg = L - wbar;
    if (p.extra) {
      const [b, c, s, f] = p.extra;
      Mdeg += b * T * T + c * Math.cos(f * T * DEG) + s * Math.sin(f * T * DEG);
    }
    const M = (mod(Mdeg + 180, 360) - 180) * DEG;
    const w = (wbar - node) * DEG;
    const O = node * DEG;
    const cw = Math.cos(w), sw = Math.sin(w), cO = Math.cos(O), sO = Math.sin(O), cI = Math.cos(I), sI = Math.sin(I);
    return {
      a, e, M,
      E: solveKepler(M, e),
      b: a * Math.sqrt(1 - e * e),
      // 軌道面 → 黄道座標 の回転
      px: cw * cO - sw * sO * cI, qx: -sw * cO - cw * sO * cI,
      py: cw * sO + sw * cO * cI, qy: -sw * sO + cw * cO * cI,
      pz: sw * sI, qz: cw * sI,
    };
  }

  /** 軌道要素と離心近点角 E → 日心黄道座標（au） */
  function pointOnOrbit(o, E, out, k) {
    const x = o.a * (Math.cos(E) - o.e);
    const y = o.b * Math.sin(E);
    out[k] = o.px * x + o.qx * y;
    out[k + 1] = o.py * x + o.qy * y;
    out[k + 2] = o.pz * x + o.qz * y;
    return out;
  }

  /** 惑星 i の日心黄道座標（au）。jdUT は表示中の日時（UT） */
  function planetPosition(i, jdUT) {
    const o = orbitAt(PLANETS[i], centuriesTT(jdUT));
    return pointOnOrbit(o, o.E, [0, 0, 0], 0);
  }

  const api = {
    DEG, J2000, AU_KM, OBLIQUITY, GREGORIAN_START_JD,
    PLANETS, SUN,
    isGregorianDate, isLeapYear, daysInMonth, jdFromCalendar, calendarFromJD, jdNow,
    deltaTSeconds, centuriesTT,
    orbitAt, pointOnOrbit, planetPosition, raDecToEcliptic, equatorialToEcliptic,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Astro = api;
})(typeof window !== 'undefined' ? window : globalThis);
