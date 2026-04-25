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
            localStorage.setItem('token', data.token);
            localStorage.setItem('user', JSON.stringify(data.user));
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
    if (localStorage.getItem('token')) {
        window.location.assign('/chat');
    }
}
checkExistingSession();
