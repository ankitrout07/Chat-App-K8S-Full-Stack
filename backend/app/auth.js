// auth.js
const supabaseUrl = 'YOUR_SUPABASE_URL';
const supabaseKey = 'YOUR_SUPABASE_ANON_KEY';
const supabase = window.supabase.createClient(supabaseUrl, supabaseKey);

function toggleAuth() {
    const loginForm = document.getElementById('login-form');
    const signupForm = document.getElementById('signup-form');
    if (loginForm.style.display === 'none') {
        loginForm.style.display = 'block';
        signupForm.style.display = 'none';
    } else {
        loginForm.style.display = 'none';
        signupForm.style.display = 'block';
    }
}

async function handleSignup() {
    const email = document.getElementById('reg-email').value;
    const password = document.getElementById('reg-password').value;
    const username = document.getElementById('reg-username').value;

    if (!email || !password || !username) {
        alert('Please fill out all fields.');
        return;
    }

    const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
            data: { display_name: username }
        }
    });

    if (error) {
        alert(error.message);
    } else {
        alert('Identity Created! Check your email for verification.');
        toggleAuth();
    }
}

async function handleLogin() {
    const email = document.getElementById('login-email').value;
    const password = document.getElementById('login-password').value;

    if (!email || !password) {
        alert('Please enter your email and password.');
        return;
    }

    const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password
    });

    if (error) {
        alert(error.message);
    } else {
        // Redirect through the Express route
        window.location.assign('/chat');
    }
}

// Auto-redirect if already logged in
(async function checkExistingSession() {
    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
        window.location.assign('/chat');
    }
})();
