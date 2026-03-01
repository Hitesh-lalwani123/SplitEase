// Groups page and group detail page
const Groups = {
    currentGroupId: null,
    groupData: null,

    async load() {
        try {
            const groups = await API.get('/groups');
            const list = document.getElementById('groups-list');
            if (groups.length) {
                list.innerHTML = groups.map(g => `
          <div class="group-card" onclick="Groups.openDetail(${g.id})">
            <div class="group-card-info">
              <h3>${this.escHtml(g.name)}</h3>
              <p>${g.description ? this.escHtml(g.description) : 'No description'}</p>
            </div>
            <div class="group-card-meta">
              <span class="member-count">${g.member_count} member${g.member_count !== 1 ? 's' : ''}</span>
            </div>
          </div>
        `).join('');
            } else {
                list.innerHTML = '<div class="empty-state">No groups yet. Create your first group!</div>';
            }
        } catch (err) {
            console.error(err);
        }
    },

    async openDetail(groupId) {
        this.currentGroupId = groupId;

        // Join Socket.IO room for real-time expense updates
        if (typeof Realtime !== 'undefined') Realtime.joinGroup(groupId);

        // Switch pages
        document.querySelectorAll('.page-section').forEach(p => p.classList.remove('active'));
        document.getElementById('group-detail-page').classList.add('active');

        // Update nav (highlight groups)
        document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
        document.querySelector('.nav-item[data-page="groups"]')?.classList.add('active');

        await this.loadDetail();
    },

    async loadDetail() {
        try {
            const [group, expenses, balances, settlements] = await Promise.all([
                API.get(`/groups/${this.currentGroupId}`),
                API.get(`/expenses/group/${this.currentGroupId}`),
                API.get(`/settlements/${this.currentGroupId}/balances`),
                API.get(`/settlements/${this.currentGroupId}/settlements`).catch(() => []),
            ]);

            this.groupData = group;
            const isAdmin = group.myRole === 'admin';
            const isOwner = group.created_by === App.currentUser?.id;
            const isMember = !isOwner; // non-owner members can leave

            document.getElementById('group-detail-name').textContent = group.name;

            // Admin controls
            document.getElementById('admin-actions-row').style.display = isAdmin ? 'flex' : 'none';
            // Settings button visible to ALL members (view-only for non-admins)
            document.getElementById('group-settings-btn').style.display = '';

            // Leave group row — visible to non-owner members
            const leaveRow = document.getElementById('leave-group-row');
            if (leaveRow) leaveRow.style.display = isMember ? '' : 'none';

            // Members (inside settings modal — element always exists in DOM)
            const membersList = document.getElementById('group-members-list');
            if (membersList) {
                membersList.innerHTML = group.members.map(m => {
                    const isCreator = m.id === group.created_by;
                    const canManage = isAdmin && m.id !== App.currentUser?.id;
                    const isTheirAdmin = m.role === 'admin';

                    return `
          <div class="member-chip member-chip-full" id="member-${m.id}">
            <div class="member-avatar" style="background:${m.avatar_color || '#14b8a6'}">
              ${m.profile_photo
                            ? `<img src="${m.profile_photo}" class="avatar-img" alt="${m.name[0]}">`
                            : m.name.charAt(0).toUpperCase()}
            </div>
            <div class="member-info-wrap">
              <span class="member-name">${this.escHtml(m.name)}</span>
              ${isCreator ? '<span class="role-badge role-creator">Owner</span>' : isTheirAdmin ? '<span class="role-badge role-admin">Admin</span>' : ''}
            </div>
            ${canManage ? `
              <div class="member-actions">
                ${!isCreator && isTheirAdmin
                                ? `<button class="btn btn-ghost btn-sm" onclick="Groups.setRole(${m.id},'member')" title="Demote to member">↓ Member</button>`
                                : !isCreator && !isTheirAdmin
                                    ? `<button class="btn btn-ghost btn-sm" onclick="Groups.setRole(${m.id},'admin')" title="Make admin">↑ Admin</button>`
                                    : ''}
                ${!isCreator ? `<button class="btn btn-danger btn-sm" onclick="Groups.removeMember(${m.id}, '${this.escHtml(m.name)}')" title="Remove">✕</button>` : ''}
              </div>
            ` : ''}
          </div>
        `;
                }).join('');
            }

            // Balances
            const balanceDetails = document.getElementById('group-balance-details');
            if (balances.transactions.length) {
                balanceDetails.innerHTML = balances.transactions.map(t => {
                    const isMyDebt = t.from.id === App.currentUser?.id;
                    return `
            <div class="balance-row">
              <strong>${this.escHtml(t.from.name)}</strong>
              <span class="arrow">→</span>
              <strong>${this.escHtml(t.to.name)}</strong>
              <span class="settle-amount">${App.currency(t.amount)}</span>
              ${isMyDebt ? `<button class="btn-settle" onclick="Settle.open(${this.currentGroupId})">Settle Up</button>` : ''}
            </div>
          `;
                }).join('');
            } else {
                balanceDetails.innerHTML = '<div class="empty-state" style="padding:0.5rem">All settled up! ✨</div>';
            }

            // Expenses + Settlements merged by date
            const expenseList = document.getElementById('group-expenses-list');

            // Build unified activity list: tag each item with _type and _sortDate
            const expItems = expenses.map(e => ({ ...e, _type: 'expense', _sortDate: e.date || '' }));
            const settleItems = (settlements || []).map(s => ({ ...s, _type: 'settlement', _sortDate: s.created_at || '' }));
            const allItems = [...expItems, ...settleItems]
                .sort((a, b) => b._sortDate.localeCompare(a._sortDate));

            if (allItems.length) {
                expenseList.innerHTML = allItems.map(item => {
                    if (item._type === 'settlement') {
                        // Settlement card
                        const dateStr = App.formatDate(item.created_at);
                        const dateParts = (dateStr === 'Today' || dateStr === 'Yesterday')
                            ? [dateStr, ''] : dateStr.split(' ');
                        const isMe = Number(item.paid_by) === Number(App.currentUser?.id);
                        const isPaidToMe = Number(item.paid_to) === Number(App.currentUser?.id);
                        return `
                          <div class="expense-item expense-card" style="border-left:3px solid #10b981;opacity:0.92">
                            <div style="display:flex;flex-direction:column;align-items:center;min-width:32px;margin-right:8px;text-align:center">
                              <span style="font-size:0.62rem;font-weight:700;color:#94a3b8;text-transform:uppercase;line-height:1.2">${dateParts[0]}</span>
                              ${dateParts[1] ? `<span style="font-size:0.62rem;color:#64748b;line-height:1.2">${dateParts[1]}</span>` : ''}
                            </div>
                            <div class="expense-icon" style="background:#10b98122;color:#10b981">🤝</div>
                            <div class="expense-main">
                              <div class="expense-desc" style="color:#10b981;font-weight:600">
                                ${this.escHtml(item.paid_by_name)} settled up with ${this.escHtml(item.paid_to_name)}
                              </div>
                              <div class="expense-meta">Settlement · ${App.currency(item.amount)}</div>
                            </div>
                            <div class="expense-right">
                              <div style="text-align:right">
                                <span class="expense-amount" style="color:#10b981">${App.currency(item.amount)}</span>
                                ${isMe ? '<div style="font-size:0.72rem;color:#10b981;font-weight:600;margin-top:2px">you paid</div>' : ''}
                                ${isPaidToMe ? '<div style="font-size:0.72rem;color:#10b981;font-weight:600;margin-top:2px">you received</div>' : ''}
                              </div>
                            </div>
                          </div>`;
                    }
                    return Expenses.renderItem(item, false);
                }).join('');
            } else {
                expenseList.innerHTML = '<div class="empty-state">No expenses in this group yet</div>';
            }

            // Admin panels
            if (isAdmin) {
                this.loadJoinRequests();
                this.loadLeaveRequests();
            } else {
                document.getElementById('join-requests-section').style.display = 'none';
                document.getElementById('leave-requests-section').style.display = 'none';
            }

        } catch (err) {
            console.error(err);
            App.toast('Failed to load group', 'error');
        }
    },

    async loadLeaveRequests() {
        try {
            const requests = await API.get(`/groups/${this.currentGroupId}/leave-requests`);
            const section = document.getElementById('leave-requests-section');
            const list = document.getElementById('leave-requests-list');
            if (!requests.length) { section.style.display = 'none'; return; }
            section.style.display = '';
            list.innerHTML = requests.map(r => `
        <div class="join-request-row" id="lr-${r.user_id}">
          <div class="member-avatar member-avatar-sm" style="background:${r.avatar_color || '#14b8a6'}">${r.name[0].toUpperCase()}</div>
          <div class="jr-info">
            <strong>${this.escHtml(r.name)}</strong>
            <span class="jr-email">${this.escHtml(r.email)}</span>
          </div>
          <div class="jr-actions">
            <button class="btn btn-primary btn-sm" onclick="Groups.approveLeave(${r.user_id})">✓ Approve</button>
            <button class="btn btn-danger btn-sm" onclick="Groups.rejectLeave(${r.user_id})">✕ Reject</button>
          </div>
        </div>
      `).join('');
        } catch (err) {
            console.error('Failed to load leave requests', err);
        }
    },

    async requestLeave() {
        if (!this.currentGroupId) return;
        if (!confirm('Request to leave this group?\n\nAn admin needs to approve. Your expense history will be preserved.')) return;

        const btn = document.getElementById('leave-group-btn');
        if (btn) { btn.disabled = true; btn.textContent = 'Requesting…'; }

        try {
            const res = await API.post(`/groups/${this.currentGroupId}/leave`);
            App.toast(res.message || 'Leave request sent ⏳');
            // Show pending badge
            document.getElementById('leave-pending-badge').style.display = '';
            if (btn) btn.textContent = '⏳ Leave Requested';
            // leave btn stays disabled — request is pending
        } catch (err) {
            App.toast('❌ ' + err.message, 'error');
            // Re-enable button so they can try again after settling
            if (btn) { btn.disabled = false; btn.textContent = '🚪 Leave Group'; }
        }
    },

    async approveLeave(userId) {
        try {
            await API.post(`/groups/${this.currentGroupId}/leave-requests/${userId}/approve`);
            document.getElementById(`lr-${userId}`)?.remove();
            App.toast('Leave approved ✓');
            this.loadDetail();
        } catch (err) { App.toast(err.message, 'error'); }
    },

    async rejectLeave(userId) {
        try {
            await API.post(`/groups/${this.currentGroupId}/leave-requests/${userId}/reject`);
            document.getElementById(`lr-${userId}`)?.remove();
            App.toast('Leave rejected');
            const remaining = document.querySelectorAll('#leave-requests-list .join-request-row');
            if (!remaining.length) document.getElementById('leave-requests-section').style.display = 'none';
        } catch (err) { App.toast(err.message, 'error'); }
    },

    async loadJoinRequests() {
        try {
            const requests = await API.get(`/groups/${this.currentGroupId}/join-requests`);
            const section = document.getElementById('join-requests-section');
            const list = document.getElementById('join-requests-list');

            if (requests.length === 0) {
                section.style.display = 'none';
                return;
            }

            section.style.display = '';
            list.innerHTML = requests.map(r => `
        <div class="join-request-row" id="jr-${r.user_id}">
          <div class="member-avatar member-avatar-sm" style="background:${r.avatar_color || '#14b8a6'}">${r.name[0].toUpperCase()}</div>
          <div class="jr-info">
            <strong>${this.escHtml(r.name)}</strong>
            <span class="jr-email">${this.escHtml(r.email)}</span>
          </div>
          <div class="jr-actions">
            <button class="btn btn-primary btn-sm" onclick="Groups.approveRequest(${r.user_id})">✓ Approve</button>
            <button class="btn btn-danger btn-sm" onclick="Groups.rejectRequest(${r.user_id})">✕ Reject</button>
          </div>
        </div>
      `).join('');
        } catch (err) {
            console.error('Failed to load join requests', err);
        }
    },

    async approveRequest(userId) {
        try {
            await API.post(`/groups/${this.currentGroupId}/join-requests/${userId}/approve`);
            document.getElementById(`jr-${userId}`)?.remove();
            App.toast('Request approved! ✓');
            this.loadDetail();
        } catch (err) {
            App.toast(err.message, 'error');
        }
    },

    async rejectRequest(userId) {
        try {
            await API.post(`/groups/${this.currentGroupId}/join-requests/${userId}/reject`);
            document.getElementById(`jr-${userId}`)?.remove();
            App.toast('Request rejected');
            // hide section if no more requests
            const remaining = document.querySelectorAll('.join-request-row');
            if (remaining.length === 0) document.getElementById('join-requests-section').style.display = 'none';
        } catch (err) {
            App.toast(err.message, 'error');
        }
    },

    async setRole(userId, role) {
        try {
            await API.put(`/groups/${this.currentGroupId}/members/${userId}/role`, { role });
            App.toast(`Role updated to ${role}`);
            this.loadDetail();
        } catch (err) {
            App.toast(err.message, 'error');
        }
    },

    async removeMember(userId, name) {
        if (!confirm(`Remove ${name} from this group?`)) return;
        try {
            await API.delete(`/groups/${this.currentGroupId}/members/${userId}`);
            App.toast(`${name} removed`);
            this.loadDetail();
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

// ── Group Settings ────────────────────────────────────────────────────────────
const GroupSettings = {

    open() {
        const group = Groups.groupData;
        if (!group) return;

        const isAdmin = group.myRole === 'admin';
        const isOwner = group.created_by === App.currentUser?.id;

        // Pre-fill fields
        document.getElementById('settings-group-name').value = group.name;
        document.getElementById('settings-group-desc').value = group.description || '';

        // Read-only mode for non-admins
        const readOnly = !isAdmin;
        ['settings-group-name', 'settings-group-desc'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.readOnly = readOnly;
        });
        const saveBtn = document.querySelector('#group-settings-form button[type="submit"]');
        if (saveBtn) saveBtn.style.display = readOnly ? 'none' : '';

        // Retention — only shown to owner
        const retentionWrap = document.getElementById('settings-retention-wrap');
        if (isOwner) {
            retentionWrap.style.display = '';
            const retSel = document.getElementById('settings-retention');
            const currentVal = group.retention_days ? String(group.retention_days) : '';
            const options = ['', '30', '90', '180', '365', '730'];
            retSel.value = options.includes(currentVal) ? currentVal : '';
            retSel.disabled = false;
        } else {
            retentionWrap.style.display = 'none';
        }

        // Danger zone — only shown to owner
        document.getElementById('settings-danger-zone').style.display = isOwner ? '' : 'none';

        // Member management — shown to admins
        const memberMgmt = document.getElementById('settings-member-management');
        if (memberMgmt) memberMgmt.style.display = isAdmin ? '' : 'none';

        // Join code — show to all members
        const memberJoinCode = document.getElementById('settings-member-join-code');
        if (memberJoinCode) memberJoinCode.textContent = group.join_code || '—';

        // Show join code inside admin section too
        if (isAdmin && group.join_code) {
            const codeRow = document.getElementById('settings-join-code-row');
            const codeVal = document.getElementById('settings-join-code-value');
            if (codeRow && codeVal) {
                codeVal.textContent = group.join_code;
                codeRow.style.display = '';
            }
        }

        // Load custom categories
        this.loadCustomCategories();

        App.openModal('group-settings-modal');
    },

    async save() {
        const name = document.getElementById('settings-group-name').value.trim();
        const description = document.getElementById('settings-group-desc').value.trim();
        const retentionVal = document.getElementById('settings-retention').value;
        const retention_days = retentionVal === '' ? null : parseInt(retentionVal);

        if (!name) { App.toast('Group name cannot be empty', 'error'); return; }

        try {
            await API.put(`/groups/${Groups.currentGroupId}`, { name, description, retention_days });
            App.toast('Group settings saved ✓');
            App.closeModal('group-settings-modal');
            Groups.loadDetail();
        } catch (err) {
            App.toast(err.message, 'error');
        }
    },

    async deleteGroup() {
        const group = Groups.groupData;
        if (!group) return;

        const confirmed = window.confirm(
            `⚠️ Delete "${group.name}"?\n\nThis will permanently delete the group, all expenses, and all balances. This CANNOT be undone.`
        );
        if (!confirmed) return;

        const confirmed2 = window.confirm(`Are you absolutely sure? Type OK to confirm deletion of "${group.name}".`);
        if (!confirmed2) return;

        try {
            await API.delete(`/groups/${Groups.currentGroupId}`);
            App.toast(`Group "${group.name}" deleted`);
            App.closeModal('group-settings-modal');
            Groups.currentGroupId = null;
            Groups.groupData = null;
            App.navigate('groups');
            Groups.load();
            Dashboard.load();
        } catch (err) {
            App.toast(err.message, 'error');
        }
    },

    async loadCustomCategories() {
        try {
            const categories = await API.get('/expenses/categories');
            const customCats = categories.filter(c => c.is_custom);
            const container = document.getElementById('custom-categories-list');

            if (!customCats.length) {
                container.innerHTML = '<span style="color:var(--text-muted);font-size:0.82rem">No custom categories yet</span>';
                return;
            }

            container.innerHTML = customCats.map(c => `
        <div class="custom-cat-chip" id="custom-cat-${c.id}"
             style="display:flex;align-items:center;gap:0.4rem;padding:0.3rem 0.6rem;background:${c.color}22;border:1px solid ${c.color}66;border-radius:20px;font-size:0.82rem">
          <span>${c.icon}</span>
          <span style="color:${c.color};font-weight:500">${this.escHtml(c.name)}</span>
          <button onclick="GroupSettings.deleteCategory(${c.id}, '${this.escHtml(c.name)}')"
                  style="background:none;border:none;cursor:pointer;color:${c.color};opacity:0.7;padding:0;font-size:0.75rem;line-height:1" title="Delete">✕</button>
        </div>
      `).join('');
        } catch (err) {
            console.error('Failed to load custom categories', err);
        }
    },

    async deleteCategory(catId, name) {
        if (!confirm(`Delete custom category "${name}"? Expenses will be moved to "Other".`)) return;
        try {
            await API.delete(`/expenses/categories/${catId}`);
            document.getElementById(`custom-cat-${catId}`)?.remove();
            App.toast(`Category "${name}" deleted`);
            // Reload category selector in expense modal if open
            if (document.getElementById('expense-modal').classList.contains('open')) {
                Expenses.loadCategories?.();
            }
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

// Bind group form
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('group-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = document.getElementById('group-name-input').value.trim();
        const description = document.getElementById('group-desc-input').value.trim();
        if (!name) return;

        try {
            await API.post('/groups', { name, description });
            App.closeModal('group-modal');
            App.toast('Group created! 🎉');
            document.getElementById('group-form').reset();
            Groups.load();
            Dashboard.load();
        } catch (err) {
            App.toast(err.message, 'error');
        }
    });

    // Back button
    document.getElementById('back-to-groups')?.addEventListener('click', () => {
        App.navigate('groups');
    });

    // Group Settings button
    document.getElementById('group-settings-btn')?.addEventListener('click', () => {
        GroupSettings.open();
    });

    // Group Settings form submit
    document.getElementById('group-settings-form')?.addEventListener('submit', (e) => {
        e.preventDefault();
        GroupSettings.save();
    });

    // Delete group button
    document.getElementById('delete-group-btn')?.addEventListener('click', () => {
        GroupSettings.deleteGroup();
    });

    // Open custom category modal
    document.getElementById('open-custom-category-btn')?.addEventListener('click', (e) => {
        e.preventDefault();
        document.getElementById('custom-category-form').reset();
        document.getElementById('custom-cat-color').value = '#14b8a6';
        document.getElementById('custom-cat-color-preview').textContent = '#14b8a6';
        // Clear keyword tags
        const wrap = document.getElementById('keyword-tags-wrap');
        if (wrap) {
            [...wrap.querySelectorAll('.kw-chip')].forEach(c => c.remove());
            document.getElementById('keyword-tag-input').value = '';
        }
        App.openModal('custom-category-modal');
    });

    // Custom category color preview
    document.getElementById('custom-cat-color')?.addEventListener('input', (e) => {
        document.getElementById('custom-cat-color-preview').textContent = e.target.value;
    });

    // Custom category form submit
    document.getElementById('custom-category-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = document.getElementById('custom-cat-name').value.trim();
        const icon = document.getElementById('custom-cat-icon').value.trim();
        const color = document.getElementById('custom-cat-color').value;

        if (!name || !icon) { App.toast('Name and icon are required', 'error'); return; }

        // Collect keyword chips
        const chips = document.querySelectorAll('#keyword-tags-wrap .kw-chip');
        const keywords = [...chips].map(c => c.dataset.kw).filter(Boolean);
        // Also grab anything still typed in the input
        const raw = document.getElementById('keyword-tag-input')?.value.trim();
        if (raw) keywords.push(...raw.split(/[,]+/).map(k => k.trim()).filter(Boolean));

        try {
            await API.post('/expenses/categories', { name, icon, color, keywords });
            App.toast(`Category "${name}" created! 🏷️`);
            App.closeModal('custom-category-modal');
            // Refresh custom categories list in settings modal
            GroupSettings.loadCustomCategories();
            // Refresh category selector in expense modal if it's loaded
            if (typeof Expenses !== 'undefined') Expenses.loadCategories?.();
        } catch (err) {
            App.toast(err.message, 'error');
        }
    });

    // Keyword tag input — press Enter or comma to add a chip
    document.getElementById('keyword-tag-input')?.addEventListener('keydown', (e) => {
        const input = e.target;
        if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            const val = input.value.replace(/,/g, '').trim();
            if (!val) return;
            addKeywordChip(val);
            input.value = '';
        } else if (e.key === 'Backspace' && !input.value) {
            // Remove last chip
            const last = document.querySelector('#keyword-tags-wrap .kw-chip:last-of-type');
            last?.remove();
        }
    });

    // Add member (by email — admin only, inside group settings)
    document.getElementById('member-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('member-email-input').value.trim();
        if (!email || !Groups.currentGroupId) return;

        try {
            await API.post(`/groups/${Groups.currentGroupId}/members`, { email });
            App.toast('Member added! 👋');
            document.getElementById('member-email-input').value = '';
            Groups.loadDetail();
        } catch (err) {
            App.toast(err.message, 'error');
        }
    });

    // Copy join code — all-members card
    document.getElementById('copy-member-join-code-btn')?.addEventListener('click', () => {
        const code = document.getElementById('settings-member-join-code')?.textContent;
        if (code && code !== '—') {
            navigator.clipboard.writeText(code).then(() => App.toast('Join code copied! 📋'))
                .catch(() => App.toast('Code: ' + code));
        }
    });

    // Invite member by email (admin only — opens full invite modal)
    document.getElementById('invite-member-btn')?.addEventListener('click', () => {
        Invitations.currentGroupId = Groups.currentGroupId;
        Invitations.loadPendingInvites();

        // Show join code in invite modal
        const group = Groups.groupData;
        const codeEl = document.getElementById('invite-modal-join-code');
        const codePill = document.getElementById('invite-modal-code-value');
        if (codeEl && codePill && group?.join_code) {
            codePill.textContent = group.join_code;
            codeEl.style.display = '';
        }

        App.closeModal('group-settings-modal'); // close settings first
        App.openModal('invite-modal');
    });

    // Copy join code (inside settings modal)
    document.getElementById('copy-settings-code-btn')?.addEventListener('click', () => {
        const code = document.getElementById('settings-join-code-value')?.textContent;
        if (code) {
            navigator.clipboard.writeText(code).then(() => App.toast('Join code copied! 📋'))
                .catch(() => App.toast('Code: ' + code));
        }
    });

    // Copy join code inside invite modal
    document.getElementById('copy-invite-code-btn')?.addEventListener('click', () => {
        const code = document.getElementById('invite-modal-code-value')?.textContent;
        if (code) {
            navigator.clipboard.writeText(code).then(() => App.toast('Join code copied! 📋'))
                .catch(() => App.toast('Code: ' + code));
        }
    });

    // Group add expense — pre-select current group
    document.getElementById('group-add-expense-btn')?.addEventListener('click', () => {
        Expenses.openModal(Groups.currentGroupId);
    });

    // Settle up
    document.getElementById('group-settle-btn')?.addEventListener('click', () => {
        Settle.open(Groups.currentGroupId);
    });

    // Leave group button
    document.getElementById('leave-group-btn')?.addEventListener('click', () => {
        Groups.requestLeave();
    });

    // Join group button (in groups page)
    document.getElementById('join-group-btn')?.addEventListener('click', () => {
        App.openModal('join-group-modal');
    });

    // Join group form submit
    document.getElementById('join-group-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const code = document.getElementById('join-code-input').value.trim().toUpperCase();
        if (!code) return;
        try {
            const result = await API.post('/groups/join', { join_code: code });
            App.closeModal('join-group-modal');
            App.toast(result.message || `Join request sent! ⏳`);
            document.getElementById('join-group-form').reset();
        } catch (err) {
            App.toast(err.message, 'error');
        }
    });
});

// ── Keyword chip helper ──────────────────────────────────────────────────────
function addKeywordChip(keyword) {
    const wrap = document.getElementById('keyword-tags-wrap');
    const input = document.getElementById('keyword-tag-input');
    if (!wrap || !input) return;
    const chip = document.createElement('span');
    chip.className = 'kw-chip';
    chip.dataset.kw = keyword;
    chip.style.cssText = 'display:inline-flex;align-items:center;gap:0.25rem;padding:0.15rem 0.5rem;background:rgba(20,184,166,0.15);border:1px solid rgba(20,184,166,0.4);border-radius:12px;font-size:0.78rem;color:#14b8a6;white-space:nowrap';
    chip.innerHTML = `${keyword} <button type="button" style="background:none;border:none;cursor:pointer;color:#14b8a6;padding:0;font-size:0.75rem;line-height:1" onclick="this.parentElement.remove()">×</button>`;
    wrap.insertBefore(chip, input);
}
