// Group invitations frontend logic
const Invitations = {
    currentGroupId: null,

    bindButtons() {
        // Invite button in group detail
        document.getElementById('invite-member-btn').addEventListener('click', () => {
            this.currentGroupId = Groups.currentGroupId;
            this.loadPendingInvites();
            App.openModal('invite-modal');
        });

        // Invite form submit
        document.getElementById('invite-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = document.getElementById('invite-email-input').value.trim();
            if (!email || !this.currentGroupId) return;

            try {
                const result = await API.post('/invitations/send', { groupId: this.currentGroupId, email });
                App.toast('Invitation sent! 📧');
                document.getElementById('invite-form').reset();
                this.loadPendingInvites();
            } catch (err) {
                App.toast(err.message, 'error');
            }
        });
    },

    async loadPendingInvites() {
        if (!this.currentGroupId) return;
        try {
            const invites = await API.get(`/invitations/group/${this.currentGroupId}`);
            const list = document.getElementById('pending-invites-list');
            if (!invites.length) {
                list.innerHTML = '<div style="color:var(--text-muted);font-size:0.8rem">No pending invitations</div>';
                return;
            }
            list.innerHTML = invites.map(inv => `
        <div class="pending-invite-row">
          <div>
            <div style="font-size:0.9rem">${inv.invited_email}</div>
            <div style="color:var(--text-muted);font-size:0.75rem">Invited by ${inv.invited_by_name}</div>
          </div>
          <button class="btn btn-ghost btn-sm" onclick="Invitations.cancelInvite(${inv.id})" style="color:#f87171">Cancel</button>
        </div>
      `).join('');
        } catch (e) { }
    },

    async cancelInvite(inviteId) {
        try {
            await API.delete(`/invitations/${inviteId}`);
            App.toast('Invitation cancelled');
            this.loadPendingInvites();
        } catch (err) {
            App.toast(err.message, 'error');
        }
    },

    // Handle accept invite when logged in (called from app init if token in localStorage)
    async acceptPendingToken() {
        const token = localStorage.getItem('pendingInviteToken');
        if (!token || !API.token) return;
        localStorage.removeItem('pendingInviteToken');
        try {
            const result = await API.post('/invitations/accept', { token });
            if (result.group) App.toast(`Joined group "${result.group.name}"! 🎉`);
        } catch (err) {
            App.toast(err.message || 'Could not accept invitation', 'error');
        }
    },
};

document.addEventListener('DOMContentLoaded', () => {
    Invitations.bindButtons();
});
