// Expenses — multi-payer with single-payer amount field, equal-split member checkboxes, edit expense, group pre-select
const Expenses = {
    editingId: null,
    currentGroupId: null,
    groupMembers: [],
    selectedCategoryId: null,
    splitType: 'equal',

    async openModal(preselectedGroupId = null, editExpenseId = null) {
        this.editingId = editExpenseId;
        this.currentGroupId = preselectedGroupId;
        this.splitType = 'equal';
        this.selectedCategoryId = null;

        const form = document.getElementById('expense-form');
        form.reset();
        document.getElementById('expense-modal-title').textContent = editExpenseId ? 'Edit Expense' : 'Add Expense';
        document.getElementById('expense-submit-btn').textContent = editExpenseId ? 'Update Expense' : 'Save Expense';
        document.getElementById('auto-category-badge').classList.add('hidden');
        document.getElementById('custom-splits').classList.add('hidden');
        document.getElementById('equal-split-members').classList.add('hidden');
        document.getElementById('payers-total-row').style.display = 'none';
        document.getElementById('single-payer-amount-wrap').style.display = 'none';
        document.querySelectorAll('.split-type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === 'equal'));

        // Set today's date
        document.getElementById('expense-date').value = new Date().toISOString().split('T')[0];

        // Group selector visibility
        const groupWrap = document.getElementById('expense-group-wrap');
        if (preselectedGroupId) {
            groupWrap.style.display = 'none';
        } else {
            groupWrap.style.display = '';
            await this.populateGroups();
        }

        // Populate categories (fetch fresh to include custom ones)
        await this.loadCategories();

        // Load group members
        if (preselectedGroupId) {
            await this.loadGroupMembers(preselectedGroupId);
        } else {
            this.groupMembers = [];
            this.renderPayers();
        }

        if (editExpenseId) {
            await this.prefillEdit(editExpenseId);
        }

        App.openModal('expense-modal');
    },

    async loadGroupMembers(groupId) {
        try {
            const group = await API.get(`/groups/${groupId}`);
            this.groupMembers = group.members || [];
            this.renderPayers();
            this.renderEqualMemberCheckboxes();
        } catch (e) {
            this.groupMembers = [];
        }
    },

    async onGroupChange(groupId) {
        if (!groupId) return;
        this.currentGroupId = groupId;
        await this.loadGroupMembers(groupId);
        this.updateCustomSplits();
        this.setSplitType(this.splitType);
    },

    // ── Payers UI ───────────────────────────────────────────────────────────
    renderPayers() {
        const container = document.getElementById('payers-list');
        if (!this.groupMembers.length) {
            container.innerHTML = '<div class="empty-state" style="padding:0.5rem;font-size:0.85rem">Select a group first</div>';
            return;
        }

        container.innerHTML = this.groupMembers.map(m => `
      <div class="payer-row" data-user-id="${m.id}">
        <label class="payer-label">
          <input type="checkbox" class="payer-check" value="${m.id}" onchange="Expenses.onPayerToggle(${m.id})">
          <div class="member-avatar-sm" style="background:${m.avatar_color}">${m.name.charAt(0).toUpperCase()}</div>
          <span>${this.escHtml(m.name)}</span>
        </label>
        <div class="payer-amount-wrap hidden" id="payer-amount-${m.id}">
          <span class="currency-prefix">₹</span>
          <input type="number" class="payer-amount-input" placeholder="0.00" step="0.01" min="0"
            oninput="Expenses.updatePayersTotal()" id="payer-amt-${m.id}">
        </div>
      </div>
    `).join('');

        // Auto-select current user if they're a member
        if (App.currentUser) {
            const selfId = App.currentUser.id;
            const selfCheck = container.querySelector(`.payer-check[value="${selfId}"]`);
            if (selfCheck) {
                selfCheck.checked = true;
                this.onPayerToggle(selfId);
            }
        }
    },

    onPayerToggle(userId) {
        const amountWrap = document.getElementById(`payer-amount-${userId}`);
        const check = document.querySelector(`.payer-check[value="${userId}"]`);
        if (!amountWrap) return;

        const checkedPayers = document.querySelectorAll('.payer-check:checked');
        const singleAmountWrap = document.getElementById('single-payer-amount-wrap');
        const multiTotalRow = document.getElementById('payers-total-row');

        if (checkedPayers.length > 1) {
            // Multi-payer: show per-payer amount fields, hide single-payer field
            singleAmountWrap.style.display = 'none';
            multiTotalRow.style.display = 'flex';
            // Show amount inputs for all checked payers
            document.querySelectorAll('.payer-check').forEach(c => {
                const wrap = document.getElementById(`payer-amount-${c.value}`);
                if (wrap) wrap.classList.toggle('hidden', !c.checked);
            });
        } else if (checkedPayers.length === 1) {
            // Single payer — show total amount input field
            document.querySelectorAll('.payer-amount-wrap').forEach(w => w.classList.add('hidden'));
            multiTotalRow.style.display = 'none';
            singleAmountWrap.style.display = 'flex';
        } else {
            amountWrap.classList.add('hidden');
            multiTotalRow.style.display = 'none';
            singleAmountWrap.style.display = 'none';
        }

        this.updatePayersTotal();
    },

    updatePayersTotal() {
        const checkedPayers = document.querySelectorAll('.payer-check:checked');
        const multiTotalRow = document.getElementById('payers-total-row');

        if (checkedPayers.length > 1) {
            let total = 0;
            checkedPayers.forEach(c => {
                const inp = document.getElementById(`payer-amt-${c.value}`);
                if (inp) total += parseFloat(inp.value) || 0;
            });

            document.getElementById('payers-total-display').textContent = `₹${total.toFixed(2)}`;
            const status = document.getElementById('payers-total-status');

            // Build breakdown: "₹100 + ₹80 = ₹180 ✓"
            const parts = Array.from(checkedPayers).map(c => {
                const inp = document.getElementById(`payer-amt-${c.value}`);
                return inp && parseFloat(inp.value) > 0 ? `₹${parseFloat(inp.value).toFixed(0)}` : null;
            }).filter(Boolean);
            if (parts.length >= 2) {
                status.textContent = parts.join(' + ') + ` = ₹${total.toFixed(2)} ✓`;
                status.style.color = total > 0 ? '#10b981' : '#f97316';
            } else {
                status.textContent = total > 0 ? '✓' : '(enter amounts above)';
                status.style.color = total > 0 ? '#10b981' : '#f97316';
            }
        }

        // Update equal split preview
        this.updateEqualSplitPreview();
    },

    getPayerTotal() {
        const checkedPayers = document.querySelectorAll('.payer-check:checked');
        if (checkedPayers.length === 0) return 0;
        if (checkedPayers.length === 1) {
            // Single payer: read from single-payer amount input
            const val = parseFloat(document.getElementById('single-payer-amount')?.value);
            return isNaN(val) ? 0 : val;
        }
        // Multi-payer
        let total = 0;
        checkedPayers.forEach(c => {
            total += parseFloat(document.getElementById(`payer-amt-${c.value}`)?.value) || 0;
        });
        return total;
    },

    buildPayersPayload() {
        const checked = Array.from(document.querySelectorAll('.payer-check:checked'));
        if (checked.length === 0) return null;

        if (checked.length === 1) {
            const totalAmt = parseFloat(document.getElementById('single-payer-amount')?.value) || 0;
            return [{ user_id: parseInt(checked[0].value), amount_paid: totalAmt }];
        }

        // Multiple payers — each has their own amount input
        return checked.map(c => ({
            user_id: parseInt(c.value),
            amount_paid: parseFloat(document.getElementById(`payer-amt-${c.value}`)?.value) || 0,
        }));
    },

    // ── Equal Split Member Selection ────────────────────────────────────────
    renderEqualMemberCheckboxes() {
        const container = document.getElementById('equal-members-list');
        container.innerHTML = this.groupMembers.map(m => `
      <label class="member-check-row">
        <input type="checkbox" class="equal-member-check" value="${m.id}" checked
          onchange="Expenses.updateEqualSplitPreview()">
        <div class="member-avatar-sm" style="background:${m.avatar_color}">${m.name.charAt(0).toUpperCase()}</div>
        <span>${this.escHtml(m.name)}</span>
      </label>
    `).join('');
        this.updateEqualSplitPreview();
    },

    updateEqualSplitPreview() {
        if (this.splitType !== 'equal') return;
        const checked = document.querySelectorAll('.equal-member-check:checked');
        const preview = document.getElementById('equal-split-preview');

        const total = this.getPayerTotal();

        if (checked.length > 0 && total > 0) {
            const share = (total / checked.length).toFixed(2);
            preview.textContent = `Each person owes ₹${share} (${checked.length} people)`;
            preview.style.color = '#14b8a6';
        } else if (checked.length > 1) {
            preview.textContent = `Split equally among ${checked.length} people`;
            preview.style.color = '#94a3b8';
        } else if (checked.length === 1) {
            preview.textContent = `Only 1 person involved`;
            preview.style.color = '#94a3b8';
        } else {
            preview.textContent = '';
        }
    },

    getInvolvedMembers() {
        if (this.splitType !== 'equal') return null;
        return Array.from(document.querySelectorAll('.equal-member-check:checked')).map(c => parseInt(c.value));
    },

    // ── Category UI ─────────────────────────────────────────────────────────
    async loadCategories() {
        try {
            App.categories = await API.get('/expenses/categories');
            this.renderCategories();
        } catch (e) {
            console.error('Failed to load categories', e);
        }
    },

    renderCategories() {
        const cats = App.categories || [];
        const sel = document.getElementById('category-selector');
        sel.innerHTML = cats.map(c => `
      <button type="button" class="category-chip ${this.selectedCategoryId === c.id ? 'active' : ''}"
        data-id="${c.id}" onclick="Expenses.selectCategory(${c.id})" title="${c.name}">
        <span>${c.icon}</span><span>${c.name}</span>
      </button>
    `).join('');
    },

    selectCategory(id) {
        this.selectedCategoryId = id;
        document.querySelectorAll('.category-chip').forEach(c => c.classList.toggle('active', parseInt(c.dataset.id) === id));
    },

    // ── Auto-categorize ─────────────────────────────────────────────────────
    async autoCategorize(description) {
        if (!description || description.length < 3) return;
        try {
            const cat = await API.post('/expenses/auto-categorize', { description });
            if (cat) {
                const badge = document.getElementById('auto-category-badge');
                badge.textContent = `${cat.icon} ${cat.name}`;
                badge.style.background = cat.color + '33';
                badge.style.color = cat.color;
                badge.classList.remove('hidden');
                this.selectCategory(cat.id);
            }
        } catch (e) { }
    },

    // ── Split type ──────────────────────────────────────────────────────────
    setSplitType(type) {
        this.splitType = type;
        document.querySelectorAll('.split-type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === type));
        const equalSection = document.getElementById('equal-split-members');
        const customSection = document.getElementById('custom-splits');

        if (type === 'equal') {
            equalSection.classList.toggle('hidden', this.groupMembers.length === 0);
            customSection.classList.add('hidden');
            this.updateEqualSplitPreview();
        } else {
            equalSection.classList.add('hidden');
            customSection.classList.remove('hidden');
            this.updateCustomSplits();
        }
    },

    updateCustomSplits(totalOverride = null) {
        if (this.splitType === 'equal') return;
        const container = document.getElementById('custom-splits');
        if (!this.groupMembers.length) { container.innerHTML = ''; return; }

        if (this.splitType === 'exact') {
            container.innerHTML = `<div class="splits-header"><span>Person</span><span>Amount (₹)</span></div>` +
                this.groupMembers.map(m => `
        <div class="split-row">
          <div class="member-info">
            <div class="member-avatar-sm" style="background:${m.avatar_color}">${m.name.charAt(0).toUpperCase()}</div>
            <span>${this.escHtml(m.name)}</span>
          </div>
          <input type="number" class="split-input" data-user="${m.id}" placeholder="0.00" step="0.01" min="0"
            oninput="Expenses.validateExact()">
        </div>`).join('') +
                `<div class="split-validation" id="split-validation"></div>`;
        } else {
            container.innerHTML = `<div class="splits-header"><span>Person</span><span>%</span></div>` +
                this.groupMembers.map((m) => `
        <div class="split-row">
          <div class="member-info">
            <div class="member-avatar-sm" style="background:${m.avatar_color}">${m.name.charAt(0).toUpperCase()}</div>
            <span>${this.escHtml(m.name)}</span>
          </div>
          <input type="number" class="split-input" data-user="${m.id}" placeholder="0" step="1" min="0" max="100"
            oninput="Expenses.validatePercentage()">
        </div>`).join('') +
                `<div class="split-validation" id="split-validation"></div>`;
        }
    },

    validateExact() {
        const inputs = document.querySelectorAll('#custom-splits .split-input');
        const total = Array.from(inputs).reduce((s, i) => s + (parseFloat(i.value) || 0), 0);
        const v = document.getElementById('split-validation');
        if (v) { v.textContent = `Total: ₹${total.toFixed(2)}`; v.style.color = total > 0 ? '#10b981' : '#f97316'; }
        return total;
    },

    validatePercentage() {
        const inputs = document.querySelectorAll('#custom-splits .split-input');
        const total = Array.from(inputs).reduce((s, i) => s + (parseFloat(i.value) || 0), 0);
        const v = document.getElementById('split-validation');
        const ok = Math.abs(total - 100) < 0.01;
        if (v) { v.textContent = `Total: ${total.toFixed(0)}% ${ok ? '✓' : '(must be 100%)'}`; v.style.color = ok ? '#10b981' : '#f97316'; }
        return ok;
    },

    // ── Populate groups dropdown ─────────────────────────────────────────────
    async populateGroups() {
        try {
            const groups = await API.get('/groups');
            const sel = document.getElementById('expense-group');
            sel.innerHTML = '<option value="">-- Select Group --</option>' +
                groups.map(g => `<option value="${g.id}">${g.name}</option>`).join('');
        } catch (e) { }
    },

    // ── Prefill for editing ──────────────────────────────────────────────────
    async prefillEdit(expenseId) {
        try {
            let expense = null;
            if (this.currentGroupId) {
                const expenses = await API.get(`/expenses/group/${this.currentGroupId}`);
                expense = expenses.find(e => e.id === expenseId);
            }
            if (!expense) return;

            document.getElementById('expense-description').value = expense.description;
            document.getElementById('expense-date').value = expense.date;
            this.selectCategory(expense.category_id);

            // Set split type
            this.setSplitType(expense.split_type || 'equal');

            // Pre-fill payers
            const payers = expense.payers || [];
            if (payers.length) {
                if (payers.length === 1) {
                    // Single payer
                    const check = document.querySelector(`.payer-check[value="${payers[0].user_id}"]`);
                    if (check) {
                        check.checked = true;
                        this.onPayerToggle(payers[0].user_id);
                        const singleInput = document.getElementById('single-payer-amount');
                        if (singleInput) singleInput.value = payers[0].amount_paid;
                    }
                } else {
                    // Multi-payer
                    payers.forEach(p => {
                        const check = document.querySelector(`.payer-check[value="${p.user_id}"]`);
                        if (check) {
                            check.checked = true;
                            this.onPayerToggle(p.user_id);
                            const amtInput = document.getElementById(`payer-amt-${p.user_id}`);
                            if (amtInput) amtInput.value = p.amount_paid;
                        }
                    });
                }
            }

            // Pre-fill splits for exact/percentage
            if ((expense.split_type === 'exact' || expense.split_type === 'percentage') && expense.splits) {
                this.updateCustomSplits();
                expense.splits.forEach(s => {
                    const inp = document.querySelector(`#custom-splits .split-input[data-user="${s.user_id}"]`);
                    if (inp) {
                        if (expense.split_type === 'exact') inp.value = s.amount_owed;
                        else inp.value = Math.round((s.amount_owed / expense.amount) * 100);
                    }
                });
            }

            // Pre-fill equal member checkboxes
            if (expense.split_type === 'equal' && expense.splits) {
                const involvedIds = expense.splits.map(s => s.user_id);
                document.querySelectorAll('.equal-member-check').forEach(c => {
                    c.checked = involvedIds.includes(parseInt(c.value));
                });
                this.updateEqualSplitPreview();
            }

            this.updatePayersTotal();
        } catch (e) {
            console.error('prefillEdit error', e);
        }
    },

    // ── Submit ──────────────────────────────────────────────────────────────
    bindForm() {
        document.getElementById('expense-form').addEventListener('submit', async (e) => {
            e.preventDefault();

            const groupId = this.currentGroupId || document.getElementById('expense-group').value;
            if (!groupId) { App.toast('Please select a group', 'error'); return; }

            const description = document.getElementById('expense-description').value.trim();
            if (!description) { App.toast('Description is required', 'error'); return; }

            const splitType = this.splitType;

            // Build payers
            const payersRaw = this.buildPayersPayload();
            if (!payersRaw || payersRaw.length === 0) { App.toast('Please select who paid', 'error'); return; }

            // Compute total
            let totalAmount = payersRaw.reduce((s, p) => s + (Number(p.amount_paid) || 0), 0);
            if (totalAmount <= 0) { App.toast('Please enter the total amount paid', 'error'); return; }

            // Build splits
            let splits = null;
            let involvedMembers = null;

            if (splitType === 'exact') {
                const inputs = document.querySelectorAll('#custom-splits .split-input');
                splits = Array.from(inputs).map(i => ({ user_id: parseInt(i.dataset.user), amount: parseFloat(i.value) || 0 })).filter(s => s.amount > 0);
                const splitTotal = splits.reduce((s, x) => s + x.amount, 0);
                if (Math.abs(splitTotal - totalAmount) > 0.05) {
                    App.toast(`Split total (₹${splitTotal.toFixed(2)}) doesn't match payers total (₹${totalAmount.toFixed(2)})`, 'error'); return;
                }
            } else if (splitType === 'percentage') {
                if (!this.validatePercentage()) { App.toast('Percentages must add up to 100%', 'error'); return; }
                const inputs = document.querySelectorAll('#custom-splits .split-input');
                splits = Array.from(inputs).map(i => ({ user_id: parseInt(i.dataset.user), percentage: parseFloat(i.value) || 0 })).filter(s => s.percentage > 0);
            } else {
                // Equal — get selected members
                involvedMembers = this.getInvolvedMembers();
                if (involvedMembers && involvedMembers.length === 0) { App.toast('Select at least one person to split with', 'error'); return; }
            }

            const payload = {
                description,
                category_id: this.selectedCategoryId || null,
                split_type: splitType,
                date: document.getElementById('expense-date').value,
                payers: payersRaw,
                splits,
                involved_members: involvedMembers,
            };


            const btn = document.getElementById('expense-submit-btn');
            btn.disabled = true;
            btn.textContent = 'Saving...';

            // ──────────── Optimistic UI (new expense only) ────────────
            let optimisticCard = null;
            if (!this.editingId) {
                const paidByMember = this.groupMembers.find(m => m.id === payersRaw[0].user_id);
                const selectedCat = (App.categories || []).find(c => c.id === this.selectedCategoryId);
                const optimisticExpense = {
                    id: null,
                    group_id: groupId,
                    description,
                    amount: totalAmount,
                    date: document.getElementById('expense-date').value || new Date().toISOString().split('T')[0],
                    paid_by_name: paidByMember?.name || App.currentUser?.name || 'You',
                    paid_by: payersRaw[0].user_id,
                    category_icon: selectedCat?.icon || '📦',
                    category_color: selectedCat?.color || '#64748b',
                    category_name: selectedCat?.name || null,
                    payers: payersRaw.map(p => ({
                        user_id: p.user_id,
                        user_name: this.groupMembers.find(m => m.id === p.user_id)?.name || 'Unknown',
                        amount_paid: p.amount_paid,
                    })),
                };

                const expenseList = document.getElementById('group-expenses-list');
                if (expenseList) {
                    const emptyState = expenseList.querySelector('.empty-state');
                    if (emptyState) emptyState.remove();

                    const wrapper = document.createElement('div');
                    wrapper.innerHTML = this.renderItem(optimisticExpense, false, { optimistic: true });
                    optimisticCard = wrapper.firstElementChild;
                    expenseList.prepend(optimisticCard);
                    // Close modal immediately for instant feel
                    App.closeModal('expense-modal');
                }
            }

            try {
                if (this.editingId) {
                    const updated = await API.put(`/expenses/${this.editingId}`, payload);
                    App.toast('Expense updated! ✏️');
                    App.closeModal('expense-modal');
                    // Replace existing card with updated data
                    const existingCard = document.querySelector(`.expense-card[data-expense-id="${this.editingId}"]`);
                    if (existingCard) existingCard.outerHTML = this.renderItem(updated, false);
                    if (Groups.currentGroupId) Groups.loadDetail();
                } else {
                    const saved = await API.post(`/expenses/group/${groupId}`, payload);
                    App.toast('Expense added! 💸');
                    // Replace optimistic card with real saved data
                    if (optimisticCard && optimisticCard.parentNode) {
                        optimisticCard.outerHTML = this.renderItem(saved, false);
                    }
                }

                // Refresh dashboard / activity if visible
                if (App.currentPage === 'dashboard') Dashboard.load();
                if (App.currentPage === 'activity') App.loadActivity();

            } catch (err) {
                App.toast(err.message || 'Failed to save expense', 'error');
                // Rollback: remove optimistic card with fade
                if (optimisticCard && optimisticCard.parentNode) {
                    optimisticCard.style.transition = 'opacity 0.3s';
                    optimisticCard.style.opacity = '0';
                    setTimeout(() => optimisticCard.remove(), 300);
                }
                // Re-open modal so user can retry
                if (!this.editingId) App.openModal('expense-modal');
            } finally {
                btn.disabled = false;
                btn.textContent = this.editingId ? 'Update Expense' : 'Save Expense';
            }
        });
    },


    // ── Render expense item ──────────────────────────────────────────────────
    renderItem(expense, showGroup = false, opts = {}) {
        const payers = expense.payers || [];
        const payerText = payers.length > 1
            ? payers.map(p => `${p.user_name} (₹${Number(p.amount_paid).toFixed(0)})`).join(', ')
            : (expense.paid_by_name || 'Unknown');

        // Any group member can edit
        const canEdit = !!App.currentUser && !opts.optimistic;
        const editBtn = canEdit ? `<button class="btn-icon-sm" onclick="Expenses.openModal(${expense.group_id || 'null'}, ${expense.id})" title="Edit">✏️</button>` : '';
        const deleteBtn = canEdit ? `<button class="btn-icon-sm delete-btn" onclick="Expenses.deleteExpense(${expense.id})" title="Delete">🗑️</button>` : '';

        const isMyExpense = payers.some(p => p.user_id === App.currentUser?.id) || expense.paid_by === App.currentUser?.id;
        const myExpenseBadge = isMyExpense ? `<span class="my-expense-tag">you paid</span>` : '';

        // Attributes differ: optimistic cards use data-optimistic for Realtime.js matching;
        // real cards use data-expense-id for Socket.IO event targeting
        const cardAttrs = opts.optimistic
            ? `data-optimistic="true" data-description="${this.escHtml(expense.description)}" data-amount="${expense.amount}"`
            : `data-expense-id="${expense.id}"`;
        const pendingOverlay = opts.optimistic
            ? `<span style="font-size:0.7rem;color:#94a3b8;margin-left:6px">Saving…</span>`
            : '';
        const cardStyle = opts.optimistic ? ` style="opacity:0.65"` : '';

        return `
      <div class="expense-item expense-card" ${cardAttrs}${cardStyle}>
        <div class="expense-icon" style="background:${expense.category_color || '#64748b'}22;color:${expense.category_color || '#64748b'}">
          ${expense.category_icon || '📦'}
        </div>
        <div class="expense-main">
          <div class="expense-desc">${this.escHtml(expense.description)} ${myExpenseBadge}${pendingOverlay}</div>
          <div class="expense-meta">
            ${showGroup ? `<span>${expense.group_name || ''}</span> · ` : ''}
            <span>paid by ${payerText}</span>
            ${expense.category_name ? ` · <span>${expense.category_name}</span>` : ''}
            <span> · ${App.formatDate(expense.date)}</span>
          </div>
        </div>
        <div class="expense-right">
          <span class="expense-amount">₹${Number(expense.amount).toFixed(2)}</span>
          <div class="expense-actions">${editBtn}${deleteBtn}</div>
        </div>
      </div>
    `;
    },

    async deleteExpense(id) {
        if (!confirm('Delete this expense?')) return;
        try {
            await API.delete(`/expenses/${id}`);
            document.getElementById(`exp-${id}`)?.remove();
            App.toast('Expense deleted');
            if (Groups.currentGroupId) Groups.loadDetail();
            if (App.currentPage === 'dashboard') Dashboard.load();
        } catch (err) {
            App.toast(err.message, 'error');
        }
    },

    escHtml(str) {
        const d = document.createElement('div');
        d.textContent = str || '';
        return d.innerHTML;
    },
};

document.addEventListener('DOMContentLoaded', () => {
    // Split type buttons
    document.querySelectorAll('.split-type-btn').forEach(btn => {
        btn.addEventListener('click', () => Expenses.setSplitType(btn.dataset.type));
    });

    // Group selector change -> load members
    document.getElementById('expense-group').addEventListener('change', (e) => {
        if (e.target.value) Expenses.onGroupChange(e.target.value);
    });

    // Description -> auto-categorize (debounced)
    let catTimer = null;
    document.getElementById('expense-description').addEventListener('input', (e) => {
        clearTimeout(catTimer);
        catTimer = setTimeout(() => Expenses.autoCategorize(e.target.value.trim()), 600);
    });

    // Single-payer amount -> update equal split preview
    document.getElementById('single-payer-amount')?.addEventListener('input', () => {
        Expenses.updateEqualSplitPreview();
        Expenses.updateCustomSplits();
    });

    // Bind form submit
    Expenses.bindForm();
});
