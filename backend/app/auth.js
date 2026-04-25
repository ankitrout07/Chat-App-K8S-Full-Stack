// auth.js

async function handleLogin() {
    const username = document.getElementById('login-email').value;

    if (!username) {
        alert('Please enter your username.');
        return;
    }

    try {
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username })
        });
        const data = await res.json();
        
        if (res.ok) {
            localStorage.setItem('vortex_auth_token', data.token);
            localStorage.setItem('vortex_auth_user', JSON.stringify(data.user));
            window.location.assign('/chat');
        } else {
            alert(data.error || 'Login failed');
        }
    } catch (err) {
        alert('Could not connect to the server.');
    }
}

// Auto-redirect if already logged in
function checkExistingSession() {
    if (localStorage.getItem('vortex_auth_token')) {
        window.location.assign('/chat');
    }
}
checkExistingSession();
