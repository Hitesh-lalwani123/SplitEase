// Profile management
const Profile = {

    open() {
        const user = App.currentUser;
        if (!user) return;

        // Fill current values
        document.getElementById('profile-name-input').value = user.name || '';
        document.getElementById('profile-email-display').textContent = user.email || '';

        // Show photo if set
        const photoEl = document.getElementById('profile-photo-preview');
        if (user.profile_photo) {
            photoEl.innerHTML = `<img src="${user.profile_photo}" alt="Photo" style="width:80px;height:80px;border-radius:50%;object-fit:cover;">`;
        } else {
            const initials = (user.name || '?').split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
            photoEl.innerHTML = `<div class="profile-avatar-big" style="background:${user.avatar_color || '#14b8a6'}">${initials}</div>`;
        }

        // Color picker - mark current
        document.querySelectorAll('.color-swatch').forEach(sw => {
            sw.classList.toggle('active', sw.dataset.color === user.avatar_color);
        });

        // Clear password fields
        document.getElementById('current-password-input').value = '';
        document.getElementById('new-password-input').value = '';
        document.getElementById('profile-error').textContent = '';

        // Hide password section for Google users
        const pwSection = document.getElementById('password-change-section');
        pwSection.style.display = user.google_id && !user.password_hash ? 'none' : '';

        App.openModal('profile-modal');
    },

    async save() {
        const name = document.getElementById('profile-name-input').value.trim();
        const currentPwd = document.getElementById('current-password-input').value;
        const newPwd = document.getElementById('new-password-input').value;
        const avatarColor = document.querySelector('.color-swatch.active')?.dataset.color;
        const photoInput = document.getElementById('profile-photo-input');

        const payload = {};
        if (name && name !== App.currentUser.name) payload.name = name;
        if (avatarColor && avatarColor !== App.currentUser.avatar_color) payload.avatar_color = avatarColor;
        if (currentPwd && newPwd) { payload.current_password = currentPwd; payload.new_password = newPwd; }

        // Handle photo upload as base64
        if (photoInput.files && photoInput.files[0]) {
            const file = photoInput.files[0];
            if (file.size > 2 * 1024 * 1024) {
                document.getElementById('profile-error').textContent = 'Photo must be under 2MB';
                return;
            }
            payload.profile_photo = await this.toBase64(file);
        }

        if (Object.keys(payload).length === 0) {
            App.closeModal('profile-modal');
            return;
        }

        try {
            const btn = document.getElementById('profile-save-btn');
            btn.disabled = true; btn.textContent = 'Saving...';

            const updated = await API.put('/auth/profile', payload);
            App.currentUser = { ...App.currentUser, ...updated };
            App.updateUserAvatar();
            App.closeModal('profile-modal');
            App.toast('Profile updated! ✓');
        } catch (err) {
            document.getElementById('profile-error').textContent = err.message || 'Failed to save';
        } finally {
            const btn = document.getElementById('profile-save-btn');
            btn.disabled = false; btn.textContent = 'Save Changes';
        }
    },

    toBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    },

    selectColor(color) {
        document.querySelectorAll('.color-swatch').forEach(sw => sw.classList.toggle('active', sw.dataset.color === color));
        // Update preview
        const photoEl = document.getElementById('profile-photo-preview');
        const hasPhoto = photoEl.querySelector('img');
        if (!hasPhoto) {
            const avatar = photoEl.querySelector('.profile-avatar-big');
            if (avatar) avatar.style.background = color;
        }
    },
};

document.addEventListener('DOMContentLoaded', () => {
    // Avatar / user name in header -> open profile
    document.getElementById('user-avatar')?.addEventListener('click', () => Profile.open());

    // Save profile form
    document.getElementById('profile-form')?.addEventListener('submit', (e) => {
        e.preventDefault();
        Profile.save();
    });

    // Color swatches
    document.querySelectorAll('.color-swatch').forEach(sw => {
        sw.addEventListener('click', () => Profile.selectColor(sw.dataset.color));
    });

    // Photo input change -> preview
    document.getElementById('profile-photo-input')?.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            document.getElementById('profile-photo-preview').innerHTML =
                `<img src="${ev.target.result}" alt="Photo" style="width:80px;height:80px;border-radius:50%;object-fit:cover;">`;
        };
        reader.readAsDataURL(file);
    });
});
