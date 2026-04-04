/* ==========================================
   Main App Controller
   ==========================================
   Handles navigation, auth state, Cloudinary
   uploads, lab notes CRUD, and tool init.
   ========================================== */

(function () {
    // ---- Auth Guard ----
    auth.onAuthStateChanged(user => {
        if (!user) {
            window.location.href = 'index.html';
            return;
        }
        initApp(user);
    });

    function initApp(user) {
        // Set user info
        document.getElementById('user-display-name').textContent = user.displayName || 'Scientist';
        document.getElementById('user-email').textContent = user.email || '';

        // Show Google avatar (read-only)
        var avatarImg = document.getElementById('avatar-img');
        var avatarInitial = document.getElementById('avatar-initial');
        if (user.photoURL) {
            avatarImg.src = user.photoURL;
            avatarImg.style.display = 'block';
            avatarInitial.style.display = 'none';
        } else {
            avatarImg.style.display = 'none';
            avatarInitial.style.display = 'flex';
            avatarInitial.textContent = (user.displayName || user.email || '?')[0].toUpperCase();
        }

        // Initialize all tools
        initNavigation();
        initPeriodicTable();
        initUnitConverter();
        initCalculator();
        initPhysicsLab();
        initChemistryLab();
        initLabNotes(user);
        initLogout();
        initMobile();
    }

    // ---- Navigation ----
    function initNavigation() {
        const navItems = document.querySelectorAll('.nav-item');
        const pages = document.querySelectorAll('.page');
        const toolCards = document.querySelectorAll('.tool-card');

        function navigateTo(pageId) {
            pages.forEach(p => p.classList.remove('active'));
            navItems.forEach(n => n.classList.remove('active'));
            const target = document.getElementById('page-' + pageId);
            if (target) target.classList.add('active');
            const navTarget = document.querySelector(`.nav-item[data-page="${pageId}"]`);
            if (navTarget) navTarget.classList.add('active');
            // Close mobile sidebar
            document.getElementById('sidebar').classList.remove('open');
        }

        navItems.forEach(item => {
            item.addEventListener('click', () => navigateTo(item.dataset.page));
        });

        toolCards.forEach(card => {
            card.addEventListener('click', () => navigateTo(card.dataset.goto));
        });
    }

    // ---- Logout ----
    function initLogout() {
        document.getElementById('logout-btn').addEventListener('click', () => {
            auth.signOut();
        });
    }

    // ---- Mobile ----
    function initMobile() {
        document.getElementById('menu-toggle').addEventListener('click', () => {
            document.getElementById('sidebar').classList.toggle('open');
        });
    }

    // ---- Periodic Table ----
    function initPeriodicTable() {
        const grid = document.getElementById('periodic-table');
        const searchInput = document.getElementById('element-search');
        const categoryFilter = document.getElementById('category-filter');
        const detailPanel = document.getElementById('element-detail');
        const detailContent = document.getElementById('element-detail-content');
        const closeDetail = document.getElementById('close-detail');
        const legendContainer = document.getElementById('periodic-legend');

        // Render legend
        const cats = [
            ['am', 'Alkali Metals'], ['ae', 'Alkaline Earth'], ['tm', 'Transition Metals'],
            ['pt', 'Post-Transition'], ['ml', 'Metalloids'], ['nm', 'Nonmetals'],
            ['hl', 'Halogens'], ['ng', 'Noble Gases'], ['ln', 'Lanthanides'], ['ac', 'Actinides']
        ];
        legendContainer.innerHTML = cats.map(([code, label]) =>
            `<div class="legend-item"><div class="legend-swatch cat-${code}"></div>${label}</div>`
        ).join('');

        // Render elements
        if (typeof ELEMENTS === 'undefined') return;

        // Add lanthanide/actinide indicators
        const indicatorLn = document.createElement('div');
        indicatorLn.className = 'element-cell indicator';
        indicatorLn.style.cssText = `grid-row:6;grid-column:3;`;
        indicatorLn.textContent = '57-71';
        grid.appendChild(indicatorLn);

        const indicatorAc = document.createElement('div');
        indicatorAc.className = 'element-cell indicator';
        indicatorAc.style.cssText = `grid-row:7;grid-column:3;`;
        indicatorAc.textContent = '89-103';
        grid.appendChild(indicatorAc);

        const cells = [];
        ELEMENTS.forEach(el => {
            const cell = document.createElement('div');
            cell.className = `element-cell cat-${el.cat}`;
            cell.style.cssText = `grid-row:${el.row};grid-column:${el.col};`;
            cell.innerHTML = `
                <span class="el-number">${el.z}</span>
                <span class="el-symbol">${el.sym}</span>
                <span class="el-name">${el.name}</span>
                <span class="el-mass">${el.mass}</span>
            `;
            cell.addEventListener('click', () => showDetail(el));
            grid.appendChild(cell);
            cells.push({ el, cell });
        });

        // Search & Filter
        function filterElements() {
            const query = searchInput.value.toLowerCase().trim();
            const cat = categoryFilter.value;
            cells.forEach(({ el, cell }) => {
                const matchSearch = !query ||
                    el.name.toLowerCase().includes(query) ||
                    el.sym.toLowerCase().includes(query) ||
                    String(el.z).includes(query);
                const matchCat = cat === 'all' || el.cat === cat;
                cell.classList.toggle('dimmed', !(matchSearch && matchCat));
            });
        }
        searchInput.addEventListener('input', filterElements);
        categoryFilter.addEventListener('change', filterElements);

        // Detail panel
        function showDetail(el) {
            const catNames = {
                am: 'Alkali Metal', ae: 'Alkaline Earth Metal', tm: 'Transition Metal',
                pt: 'Post-Transition Metal', ml: 'Metalloid', nm: 'Reactive Nonmetal',
                hl: 'Halogen', ng: 'Noble Gas', ln: 'Lanthanide', ac: 'Actinide', un: 'Unknown'
            };
            detailContent.innerHTML = `
                <div class="detail-header">
                    <div class="detail-symbol cat-${el.cat}">${el.sym}</div>
                    <div class="detail-name">
                        <h3>${el.name}</h3>
                        <p>Element ${el.z} · ${catNames[el.cat] || 'Unknown'}</p>
                    </div>
                </div>
                <div class="detail-props">
                    <div class="detail-prop">
                        <div class="detail-prop-label">Atomic Number</div>
                        <div class="detail-prop-value">${el.z}</div>
                    </div>
                    <div class="detail-prop">
                        <div class="detail-prop-label">Atomic Mass</div>
                        <div class="detail-prop-value">${el.mass} u</div>
                    </div>
                    <div class="detail-prop">
                        <div class="detail-prop-label">Period</div>
                        <div class="detail-prop-value">${el.period}</div>
                    </div>
                    <div class="detail-prop">
                        <div class="detail-prop-label">Group</div>
                        <div class="detail-prop-value">${el.group || '—'}</div>
                    </div>
                    <div class="detail-prop">
                        <div class="detail-prop-label">Electron Config</div>
                        <div class="detail-prop-value" style="font-size:0.8rem">${el.econfig || '—'}</div>
                    </div>
                    <div class="detail-prop">
                        <div class="detail-prop-label">State (STP)</div>
                        <div class="detail-prop-value">${el.state || '—'}</div>
                    </div>
                </div>`;
            detailPanel.classList.remove('hidden');
            // Add overlay
            let overlay = document.querySelector('.overlay');
            if (!overlay) {
                overlay = document.createElement('div');
                overlay.className = 'overlay';
                document.body.appendChild(overlay);
            }
            overlay.addEventListener('click', closeDetailPanel);
        }

        function closeDetailPanel() {
            detailPanel.classList.add('hidden');
            const overlay = document.querySelector('.overlay');
            if (overlay) overlay.remove();
        }
        closeDetail.addEventListener('click', closeDetailPanel);
    }

    // ---- Unit Converter ----
    function initUnitConverter() {
        if (typeof UNIT_DATA === 'undefined') return;
        const catContainer = document.getElementById('conv-categories');
        const fromVal = document.getElementById('conv-from-val');
        const toVal = document.getElementById('conv-to-val');
        const fromUnit = document.getElementById('conv-from-unit');
        const toUnit = document.getElementById('conv-to-unit');
        const swapBtn = document.getElementById('conv-swap');
        const formulaDiv = document.getElementById('conv-formula');

        let currentCat = Object.keys(UNIT_DATA)[0];

        // Render categories
        Object.keys(UNIT_DATA).forEach(cat => {
            const btn = document.createElement('button');
            btn.className = 'conv-cat-btn' + (cat === currentCat ? ' active' : '');
            btn.textContent = cat;
            btn.addEventListener('click', () => {
                catContainer.querySelectorAll('.conv-cat-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                currentCat = cat;
                populateUnits();
                convert();
            });
            catContainer.appendChild(btn);
        });

        function populateUnits() {
            const units = Object.keys(UNIT_DATA[currentCat]);
            fromUnit.innerHTML = units.map(u => `<option value="${u}">${u}</option>`).join('');
            toUnit.innerHTML = units.map((u, i) => `<option value="${u}" ${i === 1 ? 'selected' : ''}>${u}</option>`).join('');
        }

        function convert() {
            const val = parseFloat(fromVal.value);
            if (isNaN(val)) { toVal.value = ''; formulaDiv.textContent = ''; return; }
            const data = UNIT_DATA[currentCat];
            const from = fromUnit.value;
            const to = toUnit.value;

            // Temperature special case
            if (currentCat === 'Temperature') {
                const result = convertTemperature(val, from, to);
                toVal.value = result;
                formulaDiv.textContent = `${val} ${from} = ${result} ${to}`;
                return;
            }

            // Standard conversion via base unit factor
            const fromFactor = data[from];
            const toFactor = data[to];
            const result = (val * fromFactor) / toFactor;
            const display = result < 0.001 || result > 1e9 ? result.toExponential(6) : parseFloat(result.toPrecision(10));
            toVal.value = display;
            formulaDiv.textContent = `${val} ${from} = ${display} ${to}`;
        }

        function convertTemperature(val, from, to) {
            let celsius;
            if (from === 'Celsius') celsius = val;
            else if (from === 'Fahrenheit') celsius = (val - 32) * 5 / 9;
            else if (from === 'Kelvin') celsius = val - 273.15;

            let result;
            if (to === 'Celsius') result = celsius;
            else if (to === 'Fahrenheit') result = celsius * 9 / 5 + 32;
            else if (to === 'Kelvin') result = celsius + 273.15;

            return parseFloat(result.toPrecision(10));
        }

        fromVal.addEventListener('input', convert);
        fromUnit.addEventListener('change', convert);
        toUnit.addEventListener('change', convert);
        swapBtn.addEventListener('click', () => {
            const tmpUnit = fromUnit.value;
            fromUnit.value = toUnit.value;
            toUnit.value = tmpUnit;
            const tmpVal = fromVal.value;
            fromVal.value = toVal.value;
            convert();
        });

        populateUnits();
    }

    // ---- Scientific Calculator ----
    function initCalculator() {
        const display = document.getElementById('calc-result');
        const exprDisplay = document.getElementById('calc-expression');
        const historyContainer = document.getElementById('calc-history');
        const clearHistoryBtn = document.getElementById('clear-history');
        const buttons = document.querySelectorAll('.calc-btn');

        let expression = '';
        let history = [];

        buttons.forEach(btn => {
            btn.addEventListener('click', () => {
                const action = btn.dataset.action;
                switch (action) {
                    case 'num':
                        expression += btn.dataset.val;
                        display.textContent = expression;
                        break;
                    case 'op':
                        expression += btn.dataset.op;
                        display.textContent = expression;
                        break;
                    case 'func':
                        const func = btn.dataset.func;
                        if (func === 'fact') {
                            expression += '!';
                        } else if (func === 'sqrt') {
                            expression += 'sqrt(';
                        } else if (func === 'ln') {
                            expression += 'ln(';
                        } else {
                            expression += func + '(';
                        }
                        display.textContent = expression;
                        break;
                    case 'const':
                        expression += btn.dataset.val;
                        display.textContent = expression;
                        break;
                    case 'paren':
                        expression += btn.textContent;
                        display.textContent = expression;
                        break;
                    case 'clear':
                        expression = '';
                        display.textContent = '0';
                        exprDisplay.textContent = '';
                        break;
                    case 'backspace':
                        expression = expression.slice(0, -1);
                        display.textContent = expression || '0';
                        break;
                    case 'equals':
                        try {
                            const result = evaluateExpression(expression);
                            exprDisplay.textContent = expression + ' =';
                            display.textContent = result;
                            history.unshift({ expr: expression, result: result });
                            renderHistory();
                            expression = String(result);
                        } catch (e) {
                            display.textContent = 'Error';
                            setTimeout(() => { display.textContent = expression || '0'; }, 1500);
                        }
                        break;
                }
            });
        });

        function evaluateExpression(expr) {
            // Replace math functions
            let e = expr
                .replace(/sin\(/g, 'Math.sin(')
                .replace(/cos\(/g, 'Math.cos(')
                .replace(/tan\(/g, 'Math.tan(')
                .replace(/log\(/g, 'Math.log10(')
                .replace(/ln\(/g, 'Math.log(')
                .replace(/sqrt\(/g, 'Math.sqrt(')
                .replace(/π/g, 'Math.PI')
                .replace(/(\d+)!/g, 'factorial($1)');

            // Sanitize: only allow digits, operators, Math functions, parentheses, dots
            if (/[^0-9+\-*/().eE,Math.sincotaglqrfPI ]/i.test(e.replace(/factorial\(\d+\)/g, ''))) {
                throw new Error('Invalid expression');
            }

            // Add factorial function to scope
            const factorial = n => { if (n < 0) return NaN; if (n <= 1) return 1; let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; };

            const result = new Function('factorial', `"use strict"; return (${e})`)(factorial);

            if (typeof result !== 'number' || !isFinite(result)) throw new Error('Invalid');
            return parseFloat(result.toPrecision(12));
        }

        function renderHistory() {
            historyContainer.innerHTML = history.slice(0, 20).map(h =>
                `<div class="history-item" data-val="${h.result}">
                    <div class="history-expr">${h.expr}</div>
                    <div class="history-result">= ${h.result}</div>
                </div>`
            ).join('');
            historyContainer.querySelectorAll('.history-item').forEach(item => {
                item.addEventListener('click', () => {
                    expression = item.dataset.val;
                    display.textContent = expression;
                });
            });
        }

        clearHistoryBtn.addEventListener('click', () => {
            history = [];
            historyContainer.innerHTML = '';
        });
    }

    // ---- Physics Lab ----
    function initPhysicsLab() {
        if (typeof PHYSICS_TABS === 'undefined') return;
        const container = document.getElementById('physics-content');
        const tabs = document.querySelectorAll('#page-physics .lab-tab');

        function renderPhysicsTab(tabId) {
            const data = PHYSICS_TABS[tabId];
            if (!data) return;
            container.innerHTML = data.sections.map((sec, i) => `
                <div class="lab-section ${i === 0 ? 'active' : ''}" id="phys-${tabId}-${i}">
                    <h3>${sec.title}</h3>
                    <div class="formula-display">${sec.formula}</div>
                    <div class="lab-inputs">
                        ${sec.inputs.map(inp => `
                            <div class="lab-input-group">
                                <label>${inp.label} (${inp.unit})</label>
                                <input type="number" step="any" id="phys-${tabId}-${i}-${inp.id}" placeholder="${inp.label}">
                            </div>
                        `).join('')}
                    </div>
                    <button class="btn btn-primary btn-sm" onclick="window._physCalc('${tabId}',${i})">Calculate</button>
                    <div class="lab-result" id="phys-result-${tabId}-${i}"></div>
                </div>
            `).join('');
        }

        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                tabs.forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                renderPhysicsTab(tab.dataset.tab);
            });
        });

        // Calculate function
        window._physCalc = function (tabId, secIndex) {
            const sec = PHYSICS_TABS[tabId].sections[secIndex];
            const values = {};
            sec.inputs.forEach(inp => {
                const v = document.getElementById(`phys-${tabId}-${secIndex}-${inp.id}`).value;
                values[inp.id] = v === '' ? null : parseFloat(v);
            });
            const resultDiv = document.getElementById(`phys-result-${tabId}-${secIndex}`);
            try {
                const result = sec.calc(values);
                resultDiv.textContent = result;
            } catch (e) {
                resultDiv.textContent = 'Please fill in the required fields.';
            }
        };

        renderPhysicsTab('kinematics');
    }

    // ---- Chemistry Lab ----
    function initChemistryLab() {
        if (typeof CHEM_TABS === 'undefined') return;
        const container = document.getElementById('chemistry-content');
        const tabs = document.querySelectorAll('#page-chemistry .lab-tab');

        function renderChemTab(tabId) {
            const data = CHEM_TABS[tabId];
            if (!data) return;
            container.innerHTML = `
                <div class="lab-section active">
                    <h3>${data.title}</h3>
                    <div class="formula-display">${data.formula}</div>
                    ${data.html}
                    <div class="lab-result" id="chem-result-${tabId}"></div>
                </div>`;
            if (data.init) data.init();
        }

        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                tabs.forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                renderChemTab(tab.dataset.tab);
            });
        });

        renderChemTab('molweight');
    }

    // ---- Lab Notes (Firestore + Cloudinary) ----
    function initLabNotes(user) {
        const notesList = document.getElementById('notes-list');
        const editor = document.getElementById('note-editor');
        const newNoteBtn = document.getElementById('new-note-btn');
        const saveBtn = document.getElementById('save-note');
        const cancelBtn = document.getElementById('cancel-note');
        const uploadImgBtn = document.getElementById('upload-note-img');
        const titleInput = document.getElementById('note-title');
        const contentInput = document.getElementById('note-content');
        const categoryInput = document.getElementById('note-category');
        const dateSpan = document.getElementById('note-date');
        const imagesContainer = document.getElementById('note-images');

        let currentNoteId = null;
        let noteImages = [];
        let notes = [];

        // Load notes
        function loadNotes() {
            db.collection('users').doc(user.uid).collection('labNotes')
                .orderBy('updatedAt', 'desc')
                .onSnapshot(snap => {
                    notes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
                    renderNotesList();
                });
        }

        function renderNotesList() {
            if (notes.length === 0) {
                notesList.innerHTML = '<p class="empty-state">No notes yet. Click "+ New Note" to start.</p>';
                return;
            }
            notesList.innerHTML = notes.map(n => {
                const date = n.updatedAt ? new Date(n.updatedAt.seconds * 1000).toLocaleDateString() : '';
                return `<div class="note-card ${n.id === currentNoteId ? 'active' : ''}" data-id="${n.id}">
                    <div class="note-card-title">${escapeHtml(n.title || 'Untitled')}</div>
                    <div class="note-card-meta">${n.category || 'observation'} · ${date}</div>
                    <div class="note-card-preview">${escapeHtml((n.content || '').substring(0, 80))}</div>
                </div>`;
            }).join('');

            notesList.querySelectorAll('.note-card').forEach(card => {
                card.addEventListener('click', () => openNote(card.dataset.id));
            });
        }

        function openNote(noteId) {
            const note = notes.find(n => n.id === noteId);
            if (!note) return;
            currentNoteId = noteId;
            titleInput.value = note.title || '';
            contentInput.value = note.content || '';
            categoryInput.value = note.category || 'observation';
            noteImages = note.images || [];
            renderImages();
            const date = note.updatedAt ? new Date(note.updatedAt.seconds * 1000).toLocaleString() : 'New';
            dateSpan.textContent = date;
            editor.classList.remove('hidden');
            renderNotesList();
        }

        newNoteBtn.addEventListener('click', () => {
            currentNoteId = null;
            titleInput.value = '';
            contentInput.value = '';
            categoryInput.value = 'observation';
            noteImages = [];
            renderImages();
            dateSpan.textContent = new Date().toLocaleString();
            editor.classList.remove('hidden');
        });

        saveBtn.addEventListener('click', async () => {
            const data = {
                title: titleInput.value.trim() || 'Untitled Note',
                content: contentInput.value,
                category: categoryInput.value,
                images: noteImages,
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            };
            try {
                if (currentNoteId) {
                    await db.collection('users').doc(user.uid).collection('labNotes').doc(currentNoteId).update(data);
                } else {
                    data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
                    const ref = await db.collection('users').doc(user.uid).collection('labNotes').add(data);
                    currentNoteId = ref.id;
                }
            } catch (e) {
                console.error('Failed to save note:', e);
            }
        });

        cancelBtn.addEventListener('click', () => {
            editor.classList.add('hidden');
            currentNoteId = null;
            renderNotesList();
        });

        // Image upload via Cloudinary
        uploadImgBtn.addEventListener('click', () => {
            if (typeof cloudinary === 'undefined') { alert('Cloudinary widget not loaded'); return; }
            const widget = cloudinary.createUploadWidget({
                cloudName: CLOUDINARY_CLOUD_NAME,
                uploadPreset: CLOUDINARY_UPLOAD_PRESET,
                sources: ['local', 'camera'],
                multiple: true,
                maxFiles: 5,
                resourceType: 'image'
            }, (error, result) => {
                if (!error && result && result.event === 'success') {
                    noteImages.push(result.info.secure_url);
                    renderImages();
                }
            });
            widget.open();
        });

        function renderImages() {
            imagesContainer.innerHTML = noteImages.map(url =>
                `<img src="${escapeHtml(url)}" alt="Lab image">`
            ).join('');
        }

        loadNotes();
    }

    // ---- Helpers ----
    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }
})();
