/* ==========================================
   Science Tools — Converters & Calculators
   ==========================================
   Unit Converter data, Physics tabs,
   Chemistry tabs (molecular weight, molarity,
   dilution, gas laws, pH).
   ========================================== */

// ======== UNIT CONVERTER DATA ========
const UNIT_DATA = {
    'Length': {
        'Meters (m)': 1,
        'Kilometers (km)': 1000,
        'Centimeters (cm)': 0.01,
        'Millimeters (mm)': 0.001,
        'Micrometers (μm)': 1e-6,
        'Nanometers (nm)': 1e-9,
        'Miles': 1609.344,
        'Yards': 0.9144,
        'Feet': 0.3048,
        'Inches': 0.0254,
        'Light Years': 9.461e15,
        'Astronomical Units': 1.496e11
    },
    'Mass': {
        'Kilograms (kg)': 1,
        'Grams (g)': 0.001,
        'Milligrams (mg)': 1e-6,
        'Micrograms (μg)': 1e-9,
        'Metric Tons': 1000,
        'Pounds (lb)': 0.453592,
        'Ounces (oz)': 0.0283495,
        'Atomic Mass Units (u)': 1.66054e-27
    },
    'Temperature': {
        'Celsius': 1,
        'Fahrenheit': 1,
        'Kelvin': 1
    },
    'Volume': {
        'Liters (L)': 1,
        'Milliliters (mL)': 0.001,
        'Cubic Meters (m³)': 1000,
        'Cubic Centimeters (cm³)': 0.001,
        'Gallons (US)': 3.78541,
        'Quarts': 0.946353,
        'Cups': 0.236588,
        'Fluid Ounces': 0.0295735
    },
    'Speed': {
        'Meters/sec (m/s)': 1,
        'Kilometers/hr (km/h)': 0.277778,
        'Miles/hr (mph)': 0.44704,
        'Feet/sec (ft/s)': 0.3048,
        'Knots': 0.514444,
        'Speed of Light (c)': 299792458,
        'Mach': 343
    },
    'Energy': {
        'Joules (J)': 1,
        'Kilojoules (kJ)': 1000,
        'Calories (cal)': 4.184,
        'Kilocalories (kcal)': 4184,
        'Electron Volts (eV)': 1.602e-19,
        'Kilowatt-hours (kWh)': 3.6e6,
        'BTU': 1055.06
    },
    'Pressure': {
        'Pascals (Pa)': 1,
        'Kilopascals (kPa)': 1000,
        'Atmospheres (atm)': 101325,
        'Bar': 100000,
        'mmHg (Torr)': 133.322,
        'PSI': 6894.76
    },
    'Time': {
        'Seconds (s)': 1,
        'Milliseconds (ms)': 0.001,
        'Minutes (min)': 60,
        'Hours (hr)': 3600,
        'Days': 86400,
        'Weeks': 604800,
        'Years': 31557600
    },
    'Area': {
        'Square Meters (m²)': 1,
        'Square Kilometers (km²)': 1e6,
        'Square Centimeters (cm²)': 1e-4,
        'Hectares': 10000,
        'Acres': 4046.86,
        'Square Feet (ft²)': 0.092903,
        'Square Miles': 2.59e6
    },
    'Force': {
        'Newtons (N)': 1,
        'Kilonewtons (kN)': 1000,
        'Dynes': 1e-5,
        'Pound-force (lbf)': 4.44822,
        'Kilograms-force (kgf)': 9.80665
    }
};

// ======== PHYSICS LAB TABS ========
const PHYSICS_TABS = {
    kinematics: {
        sections: [
            {
                title: 'Final Velocity',
                formula: 'v = u + at',
                inputs: [
                    { id: 'u', label: 'Initial Velocity (u)', unit: 'm/s' },
                    { id: 'a', label: 'Acceleration (a)', unit: 'm/s²' },
                    { id: 't', label: 'Time (t)', unit: 's' }
                ],
                calc: v => {
                    if (v.u == null || v.a == null || v.t == null) throw 'Missing';
                    const result = v.u + v.a * v.t;
                    return `v = ${v.u} + (${v.a})(${v.t}) = ${result.toFixed(4)} m/s`;
                }
            },
            {
                title: 'Displacement',
                formula: 's = ut + ½at²',
                inputs: [
                    { id: 'u', label: 'Initial Velocity (u)', unit: 'm/s' },
                    { id: 'a', label: 'Acceleration (a)', unit: 'm/s²' },
                    { id: 't', label: 'Time (t)', unit: 's' }
                ],
                calc: v => {
                    if (v.u == null || v.a == null || v.t == null) throw 'Missing';
                    const result = v.u * v.t + 0.5 * v.a * v.t * v.t;
                    return `s = (${v.u})(${v.t}) + ½(${v.a})(${v.t})² = ${result.toFixed(4)} m`;
                }
            },
            {
                title: 'Velocity² Equation',
                formula: 'v² = u² + 2as',
                inputs: [
                    { id: 'u', label: 'Initial Velocity (u)', unit: 'm/s' },
                    { id: 'a', label: 'Acceleration (a)', unit: 'm/s²' },
                    { id: 's', label: 'Displacement (s)', unit: 'm' }
                ],
                calc: v => {
                    if (v.u == null || v.a == null || v.s == null) throw 'Missing';
                    const v2 = v.u * v.u + 2 * v.a * v.s;
                    if (v2 < 0) return 'Result is imaginary (v² < 0). Check your inputs.';
                    return `v² = ${v.u}² + 2(${v.a})(${v.s}) = ${v2.toFixed(4)} → v = ${Math.sqrt(v2).toFixed(4)} m/s`;
                }
            }
        ]
    },
    forces: {
        sections: [
            {
                title: "Newton's Second Law",
                formula: 'F = ma',
                inputs: [
                    { id: 'm', label: 'Mass (m)', unit: 'kg' },
                    { id: 'a', label: 'Acceleration (a)', unit: 'm/s²' }
                ],
                calc: v => {
                    if (v.m == null || v.a == null) throw 'Missing';
                    return `F = (${v.m})(${v.a}) = ${(v.m * v.a).toFixed(4)} N`;
                }
            },
            {
                title: 'Weight',
                formula: 'W = mg (g = 9.81 m/s²)',
                inputs: [
                    { id: 'm', label: 'Mass (m)', unit: 'kg' }
                ],
                calc: v => {
                    if (v.m == null) throw 'Missing';
                    return `W = (${v.m})(9.81) = ${(v.m * 9.81).toFixed(4)} N`;
                }
            },
            {
                title: 'Gravitational Force',
                formula: 'F = Gm₁m₂/r²',
                inputs: [
                    { id: 'm1', label: 'Mass 1 (m₁)', unit: 'kg' },
                    { id: 'm2', label: 'Mass 2 (m₂)', unit: 'kg' },
                    { id: 'r', label: 'Distance (r)', unit: 'm' }
                ],
                calc: v => {
                    if (v.m1 == null || v.m2 == null || v.r == null) throw 'Missing';
                    const G = 6.674e-11;
                    const F = G * v.m1 * v.m2 / (v.r * v.r);
                    return `F = (6.674×10⁻¹¹)(${v.m1})(${v.m2})/(${v.r})² = ${F.toExponential(4)} N`;
                }
            },
            {
                title: 'Friction',
                formula: 'f = μN',
                inputs: [
                    { id: 'mu', label: 'Coefficient (μ)', unit: '' },
                    { id: 'N', label: 'Normal Force (N)', unit: 'N' }
                ],
                calc: v => {
                    if (v.mu == null || v.N == null) throw 'Missing';
                    return `f = (${v.mu})(${v.N}) = ${(v.mu * v.N).toFixed(4)} N`;
                }
            }
        ]
    },
    energy: {
        sections: [
            {
                title: 'Kinetic Energy',
                formula: 'KE = ½mv²',
                inputs: [
                    { id: 'm', label: 'Mass (m)', unit: 'kg' },
                    { id: 'v', label: 'Velocity (v)', unit: 'm/s' }
                ],
                calc: v => {
                    if (v.m == null || v.v == null) throw 'Missing';
                    const ke = 0.5 * v.m * v.v * v.v;
                    return `KE = ½(${v.m})(${v.v})² = ${ke.toFixed(4)} J`;
                }
            },
            {
                title: 'Potential Energy',
                formula: 'PE = mgh',
                inputs: [
                    { id: 'm', label: 'Mass (m)', unit: 'kg' },
                    { id: 'g', label: 'Gravity (g)', unit: 'm/s²' },
                    { id: 'h', label: 'Height (h)', unit: 'm' }
                ],
                calc: v => {
                    if (v.m == null || v.g == null || v.h == null) throw 'Missing';
                    const pe = v.m * v.g * v.h;
                    return `PE = (${v.m})(${v.g})(${v.h}) = ${pe.toFixed(4)} J`;
                }
            },
            {
                title: 'Work',
                formula: 'W = Fd cos(θ)',
                inputs: [
                    { id: 'F', label: 'Force (F)', unit: 'N' },
                    { id: 'd', label: 'Distance (d)', unit: 'm' },
                    { id: 'theta', label: 'Angle (θ)', unit: '°' }
                ],
                calc: v => {
                    if (v.F == null || v.d == null || v.theta == null) throw 'Missing';
                    const W = v.F * v.d * Math.cos(v.theta * Math.PI / 180);
                    return `W = (${v.F})(${v.d})cos(${v.theta}°) = ${W.toFixed(4)} J`;
                }
            },
            {
                title: 'Power',
                formula: 'P = W/t',
                inputs: [
                    { id: 'W', label: 'Work (W)', unit: 'J' },
                    { id: 't', label: 'Time (t)', unit: 's' }
                ],
                calc: v => {
                    if (v.W == null || v.t == null) throw 'Missing';
                    return `P = ${v.W}/${v.t} = ${(v.W / v.t).toFixed(4)} W`;
                }
            }
        ]
    },
    momentum: {
        sections: [
            {
                title: 'Momentum',
                formula: 'p = mv',
                inputs: [
                    { id: 'm', label: 'Mass (m)', unit: 'kg' },
                    { id: 'v', label: 'Velocity (v)', unit: 'm/s' }
                ],
                calc: v => {
                    if (v.m == null || v.v == null) throw 'Missing';
                    return `p = (${v.m})(${v.v}) = ${(v.m * v.v).toFixed(4)} kg⋅m/s`;
                }
            },
            {
                title: 'Impulse',
                formula: 'J = FΔt = Δp',
                inputs: [
                    { id: 'F', label: 'Force (F)', unit: 'N' },
                    { id: 'dt', label: 'Time interval (Δt)', unit: 's' }
                ],
                calc: v => {
                    if (v.F == null || v.dt == null) throw 'Missing';
                    return `J = (${v.F})(${v.dt}) = ${(v.F * v.dt).toFixed(4)} N⋅s`;
                }
            },
            {
                title: 'Elastic Collision (1D)',
                formula: 'm₁v₁ + m₂v₂ = m₁v₁\' + m₂v₂\'',
                inputs: [
                    { id: 'm1', label: 'Mass 1 (m₁)', unit: 'kg' },
                    { id: 'v1', label: 'Velocity 1 (v₁)', unit: 'm/s' },
                    { id: 'm2', label: 'Mass 2 (m₂)', unit: 'kg' },
                    { id: 'v2', label: 'Velocity 2 (v₂)', unit: 'm/s' }
                ],
                calc: v => {
                    if (v.m1 == null || v.v1 == null || v.m2 == null || v.v2 == null) throw 'Missing';
                    const v1f = ((v.m1 - v.m2) * v.v1 + 2 * v.m2 * v.v2) / (v.m1 + v.m2);
                    const v2f = ((v.m2 - v.m1) * v.v2 + 2 * v.m1 * v.v1) / (v.m1 + v.m2);
                    return `v₁' = ${v1f.toFixed(4)} m/s, v₂' = ${v2f.toFixed(4)} m/s`;
                }
            }
        ]
    },
    waves: {
        sections: [
            {
                title: 'Wave Speed',
                formula: 'v = fλ',
                inputs: [
                    { id: 'f', label: 'Frequency (f)', unit: 'Hz' },
                    { id: 'lambda', label: 'Wavelength (λ)', unit: 'm' }
                ],
                calc: v => {
                    if (v.f == null || v.lambda == null) throw 'Missing';
                    return `v = (${v.f})(${v.lambda}) = ${(v.f * v.lambda).toFixed(4)} m/s`;
                }
            },
            {
                title: 'Period & Frequency',
                formula: 'T = 1/f',
                inputs: [
                    { id: 'f', label: 'Frequency (f)', unit: 'Hz' }
                ],
                calc: v => {
                    if (v.f == null) throw 'Missing';
                    return `T = 1/${v.f} = ${(1 / v.f).toFixed(6)} s`;
                }
            },
            {
                title: 'Photon Energy',
                formula: 'E = hf (h = 6.626×10⁻³⁴ J⋅s)',
                inputs: [
                    { id: 'f', label: 'Frequency (f)', unit: 'Hz' }
                ],
                calc: v => {
                    if (v.f == null) throw 'Missing';
                    const h = 6.626e-34;
                    const E = h * v.f;
                    return `E = (6.626×10⁻³⁴)(${v.f}) = ${E.toExponential(4)} J = ${(E / 1.602e-19).toFixed(4)} eV`;
                }
            }
        ]
    },
    electricity: {
        sections: [
            {
                title: "Ohm's Law",
                formula: 'V = IR',
                inputs: [
                    { id: 'I', label: 'Current (I)', unit: 'A' },
                    { id: 'R', label: 'Resistance (R)', unit: 'Ω' }
                ],
                calc: v => {
                    if (v.I == null || v.R == null) throw 'Missing';
                    return `V = (${v.I})(${v.R}) = ${(v.I * v.R).toFixed(4)} V`;
                }
            },
            {
                title: 'Electrical Power',
                formula: 'P = IV = I²R = V²/R',
                inputs: [
                    { id: 'I', label: 'Current (I)', unit: 'A' },
                    { id: 'V', label: 'Voltage (V)', unit: 'V' }
                ],
                calc: v => {
                    if (v.I == null || v.V == null) throw 'Missing';
                    return `P = (${v.I})(${v.V}) = ${(v.I * v.V).toFixed(4)} W`;
                }
            },
            {
                title: "Coulomb's Law",
                formula: 'F = kq₁q₂/r²  (k = 8.99×10⁹)',
                inputs: [
                    { id: 'q1', label: 'Charge 1 (q₁)', unit: 'C' },
                    { id: 'q2', label: 'Charge 2 (q₂)', unit: 'C' },
                    { id: 'r', label: 'Distance (r)', unit: 'm' }
                ],
                calc: v => {
                    if (v.q1 == null || v.q2 == null || v.r == null) throw 'Missing';
                    const k = 8.99e9;
                    const F = k * v.q1 * v.q2 / (v.r * v.r);
                    return `F = (8.99×10⁹)(${v.q1})(${v.q2})/(${v.r})² = ${F.toExponential(4)} N`;
                }
            },
            {
                title: 'Capacitance Energy',
                formula: 'E = ½CV²',
                inputs: [
                    { id: 'C', label: 'Capacitance (C)', unit: 'F' },
                    { id: 'V', label: 'Voltage (V)', unit: 'V' }
                ],
                calc: v => {
                    if (v.C == null || v.V == null) throw 'Missing';
                    const E = 0.5 * v.C * v.V * v.V;
                    return `E = ½(${v.C})(${v.V})² = ${E.toExponential(4)} J`;
                }
            }
        ]
    }
};

// ======== CHEMISTRY LAB TABS ========
const CHEM_TABS = {
    molweight: {
        title: 'Molecular Weight Calculator',
        formula: 'Enter a chemical formula (e.g., H2O, NaCl, C6H12O6, Ca(OH)2)',
        html: `
            <div class="lab-inputs">
                <div class="lab-input-group" style="grid-column:1/-1">
                    <label>Chemical Formula</label>
                    <input type="text" id="mw-formula" placeholder="e.g. H2O, C6H12O6, Ca(OH)2" style="font-size:1.2rem">
                </div>
            </div>
            <button class="btn btn-primary btn-sm" id="mw-calc-btn">Calculate</button>
            <div id="mw-breakdown" style="margin-top:16px"></div>
        `,
        init: function () {
            document.getElementById('mw-calc-btn').addEventListener('click', () => {
                const formula = document.getElementById('mw-formula').value.trim();
                const resultDiv = document.getElementById('chem-result-molweight');
                const breakdownDiv = document.getElementById('mw-breakdown');
                try {
                    const elements = parseFormula(formula);
                    let total = 0;
                    let breakdown = '';
                    for (const [sym, count] of Object.entries(elements)) {
                        const mass = ATOMIC_MASS[sym];
                        if (!mass) throw `Unknown element: ${sym}`;
                        const subtotal = mass * count;
                        total += subtotal;
                        breakdown += `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border)">
                            <span>${sym} × ${count}</span>
                            <span>${mass.toFixed(3)} × ${count} = ${subtotal.toFixed(3)} g/mol</span>
                        </div>`;
                    }
                    breakdownDiv.innerHTML = breakdown;
                    resultDiv.textContent = `Molecular Weight of ${formula} = ${total.toFixed(4)} g/mol`;
                } catch (e) {
                    resultDiv.textContent = typeof e === 'string' ? e : 'Invalid formula. Use standard notation like H2O.';
                    breakdownDiv.innerHTML = '';
                }
            });
        }
    },
    molarity: {
        title: 'Molarity Calculator',
        formula: 'M = n/V (moles per liter)',
        html: `
            <div class="lab-inputs">
                <div class="lab-input-group">
                    <label>Moles of Solute (n)</label>
                    <input type="number" step="any" id="mol-n" placeholder="moles">
                </div>
                <div class="lab-input-group">
                    <label>Volume of Solution (V)</label>
                    <input type="number" step="any" id="mol-v" placeholder="liters">
                </div>
            </div>
            <button class="btn btn-primary btn-sm" id="mol-calc-btn">Calculate</button>
        `,
        init: function () {
            document.getElementById('mol-calc-btn').addEventListener('click', () => {
                const n = parseFloat(document.getElementById('mol-n').value);
                const v = parseFloat(document.getElementById('mol-v').value);
                const result = document.getElementById('chem-result-molarity');
                if (isNaN(n) || isNaN(v) || v === 0) {
                    result.textContent = 'Please enter valid values (V ≠ 0).';
                    return;
                }
                result.textContent = `M = ${n} / ${v} = ${(n / v).toFixed(6)} mol/L`;
            });
        }
    },
    dilution: {
        title: 'Dilution Calculator',
        formula: 'M₁V₁ = M₂V₂',
        html: `
            <div class="lab-inputs">
                <div class="lab-input-group">
                    <label>Initial Molarity (M₁)</label>
                    <input type="number" step="any" id="dil-m1" placeholder="mol/L">
                </div>
                <div class="lab-input-group">
                    <label>Initial Volume (V₁)</label>
                    <input type="number" step="any" id="dil-v1" placeholder="liters">
                </div>
                <div class="lab-input-group">
                    <label>Final Molarity (M₂)</label>
                    <input type="number" step="any" id="dil-m2" placeholder="mol/L">
                </div>
                <div class="lab-input-group">
                    <label>Final Volume (V₂)</label>
                    <input type="number" step="any" id="dil-v2" placeholder="liters">
                </div>
            </div>
            <p style="font-size:0.85rem;color:var(--text-secondary);margin-bottom:12px">Leave one field empty to solve for it.</p>
            <button class="btn btn-primary btn-sm" id="dil-calc-btn">Calculate</button>
        `,
        init: function () {
            document.getElementById('dil-calc-btn').addEventListener('click', () => {
                const m1 = document.getElementById('dil-m1').value;
                const v1 = document.getElementById('dil-v1').value;
                const m2 = document.getElementById('dil-m2').value;
                const v2 = document.getElementById('dil-v2').value;
                const result = document.getElementById('chem-result-dilution');
                const vals = [m1, v1, m2, v2].map(v => v === '' ? null : parseFloat(v));
                const empties = vals.filter(v => v === null).length;
                if (empties !== 1) {
                    result.textContent = 'Leave exactly one field empty to solve for it.';
                    return;
                }
                if (vals[0] === null) {
                    result.textContent = `M₁ = (${vals[2]})(${vals[3]}) / ${vals[1]} = ${((vals[2] * vals[3]) / vals[1]).toFixed(6)} mol/L`;
                } else if (vals[1] === null) {
                    result.textContent = `V₁ = (${vals[2]})(${vals[3]}) / ${vals[0]} = ${((vals[2] * vals[3]) / vals[0]).toFixed(6)} L`;
                } else if (vals[2] === null) {
                    result.textContent = `M₂ = (${vals[0]})(${vals[1]}) / ${vals[3]} = ${((vals[0] * vals[1]) / vals[3]).toFixed(6)} mol/L`;
                } else {
                    result.textContent = `V₂ = (${vals[0]})(${vals[1]}) / ${vals[2]} = ${((vals[0] * vals[1]) / vals[2]).toFixed(6)} L`;
                }
            });
        }
    },
    gaslaw: {
        title: 'Ideal Gas Law',
        formula: 'PV = nRT (R = 8.314 J/(mol·K))',
        html: `
            <div class="lab-inputs">
                <div class="lab-input-group">
                    <label>Pressure P (Pa)</label>
                    <input type="number" step="any" id="gas-p" placeholder="Pascals">
                </div>
                <div class="lab-input-group">
                    <label>Volume V (m³)</label>
                    <input type="number" step="any" id="gas-v" placeholder="cubic meters">
                </div>
                <div class="lab-input-group">
                    <label>Moles n</label>
                    <input type="number" step="any" id="gas-n" placeholder="moles">
                </div>
                <div class="lab-input-group">
                    <label>Temperature T (K)</label>
                    <input type="number" step="any" id="gas-t" placeholder="Kelvin">
                </div>
            </div>
            <p style="font-size:0.85rem;color:var(--text-secondary);margin-bottom:12px">Leave one field empty to solve for it.</p>
            <button class="btn btn-primary btn-sm" id="gas-calc-btn">Calculate</button>
        `,
        init: function () {
            document.getElementById('gas-calc-btn').addEventListener('click', () => {
                const R = 8.314;
                const p = document.getElementById('gas-p').value;
                const v = document.getElementById('gas-v').value;
                const n = document.getElementById('gas-n').value;
                const t = document.getElementById('gas-t').value;
                const vals = [p, v, n, t].map(x => x === '' ? null : parseFloat(x));
                const result = document.getElementById('chem-result-gaslaw');
                const empties = vals.filter(x => x === null).length;
                if (empties !== 1) {
                    result.textContent = 'Leave exactly one field empty to solve for it.';
                    return;
                }
                if (vals[0] === null) {
                    const P = (vals[2] * R * vals[3]) / vals[1];
                    result.textContent = `P = nRT/V = (${vals[2]})(8.314)(${vals[3]}) / ${vals[1]} = ${P.toExponential(4)} Pa`;
                } else if (vals[1] === null) {
                    const V = (vals[2] * R * vals[3]) / vals[0];
                    result.textContent = `V = nRT/P = (${vals[2]})(8.314)(${vals[3]}) / ${vals[0]} = ${V.toExponential(4)} m³`;
                } else if (vals[2] === null) {
                    const N = (vals[0] * vals[1]) / (R * vals[3]);
                    result.textContent = `n = PV/RT = (${vals[0]})(${vals[1]}) / (8.314)(${vals[3]}) = ${N.toFixed(6)} mol`;
                } else {
                    const T = (vals[0] * vals[1]) / (vals[2] * R);
                    result.textContent = `T = PV/nR = (${vals[0]})(${vals[1]}) / (${vals[2]})(8.314) = ${T.toFixed(4)} K`;
                }
            });
        }
    },
    ph: {
        title: 'pH Calculator',
        formula: 'pH = -log₁₀[H⁺]  |  pOH = -log₁₀[OH⁻]  |  pH + pOH = 14',
        html: `
            <div class="lab-inputs">
                <div class="lab-input-group">
                    <label>Hydrogen Ion [H⁺] (mol/L)</label>
                    <input type="number" step="any" id="ph-h" placeholder="e.g. 0.001">
                </div>
            </div>
            <button class="btn btn-primary btn-sm" id="ph-calc-btn">Calculate from [H⁺]</button>
            <div style="margin-top:16px">
                <div class="lab-inputs">
                    <div class="lab-input-group">
                        <label>pH Value</label>
                        <input type="number" step="any" id="ph-val" placeholder="e.g. 7.0">
                    </div>
                </div>
                <button class="btn btn-primary btn-sm" id="ph-reverse-btn">Calculate from pH</button>
            </div>
        `,
        init: function () {
            document.getElementById('ph-calc-btn').addEventListener('click', () => {
                const h = parseFloat(document.getElementById('ph-h').value);
                const result = document.getElementById('chem-result-ph');
                if (isNaN(h) || h <= 0) { result.textContent = 'Enter a valid [H⁺] > 0.'; return; }
                const pH = -Math.log10(h);
                const pOH = 14 - pH;
                const nature = pH < 7 ? 'Acidic' : pH > 7 ? 'Basic' : 'Neutral';
                result.textContent = `pH = ${pH.toFixed(4)} | pOH = ${pOH.toFixed(4)} | ${nature}`;
            });
            document.getElementById('ph-reverse-btn').addEventListener('click', () => {
                const pH = parseFloat(document.getElementById('ph-val').value);
                const result = document.getElementById('chem-result-ph');
                if (isNaN(pH)) { result.textContent = 'Enter a valid pH value.'; return; }
                const h = Math.pow(10, -pH);
                const pOH = 14 - pH;
                const oh = Math.pow(10, -pOH);
                const nature = pH < 7 ? 'Acidic' : pH > 7 ? 'Basic' : 'Neutral';
                result.textContent = `[H⁺] = ${h.toExponential(4)} mol/L | [OH⁻] = ${oh.toExponential(4)} mol/L | ${nature}`;
            });
        }
    }
};

// ======== Chemical Formula Parser ========
function parseFormula(formula) {
    const elements = {};
    let i = 0;

    function parse(multiplier) {
        while (i < formula.length) {
            if (formula[i] === '(') {
                i++; // skip (
                parse(1);
                // read number after )
                let num = '';
                while (i < formula.length && /\d/.test(formula[i])) {
                    num += formula[i++];
                }
                const factor = num ? parseInt(num) : 1;
                // Multiply last group - handled by recursive call
                // Actually, let's use a stack approach
            } else if (formula[i] === ')') {
                i++; // skip )
                return;
            } else if (/[A-Z]/.test(formula[i])) {
                let sym = formula[i++];
                while (i < formula.length && /[a-z]/.test(formula[i])) {
                    sym += formula[i++];
                }
                let num = '';
                while (i < formula.length && /\d/.test(formula[i])) {
                    num += formula[i++];
                }
                const count = (num ? parseInt(num) : 1) * multiplier;
                elements[sym] = (elements[sym] || 0) + count;
            } else {
                i++;
            }
        }
    }

    // Better parser with parentheses support
    function parseStack(formula) {
        const stack = [{}];
        let j = 0;
        while (j < formula.length) {
            if (formula[j] === '(') {
                stack.push({});
                j++;
            } else if (formula[j] === ')') {
                j++;
                let num = '';
                while (j < formula.length && /\d/.test(formula[j])) num += formula[j++];
                const mult = num ? parseInt(num) : 1;
                const top = stack.pop();
                const current = stack[stack.length - 1];
                for (const [s, c] of Object.entries(top)) {
                    current[s] = (current[s] || 0) + c * mult;
                }
            } else if (/[A-Z]/.test(formula[j])) {
                let sym = formula[j++];
                while (j < formula.length && /[a-z]/.test(formula[j])) sym += formula[j++];
                let num = '';
                while (j < formula.length && /\d/.test(formula[j])) num += formula[j++];
                const count = num ? parseInt(num) : 1;
                const current = stack[stack.length - 1];
                current[sym] = (current[sym] || 0) + count;
            } else {
                j++;
            }
        }
        return stack[0];
    }

    return parseStack(formula);
}
