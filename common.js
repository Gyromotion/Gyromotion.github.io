function loadHeader() {
    const headerHTML = `
        <header>
            <a href="https://gyromotionphysio.in"><img src="img/logo-png.png" alt="Logo" class="logo" style="height: auto; max-width: 68%;"></a>
        </header>
        <nav>
            <ul>
                <li><a href="https://gyromotionphysio.in">Home</a></li>
                <li><a href="about.html">About</a></li>
                <li><a href="services.html">Services</a></li>
                <li><a href="appointment.html">Book an Appointment</a></li>
                <li><a href="https://gyromotionphysio.in/pms/">PMS</a></li>
            </ul>
        </nav>
    `;
    const headerEl = document.getElementById('common-header');
    if (headerEl) {
        headerEl.innerHTML = headerHTML;
    }
}

function loadFooter() {
    const footerHTML = `
        <center>
            <footer>
                <p>&copy; 2026 Gyromotion Physiotherapy Clinic. All rights reserved.</p>
            </footer>
        </center>
    `;
    const footerEl = document.getElementById('common-footer');
    if (footerEl) {
        footerEl.innerHTML = footerHTML;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    loadHeader();
    loadFooter();
});