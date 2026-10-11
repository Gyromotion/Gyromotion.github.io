import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import nodemailer from 'nodemailer';
import { google } from 'googleapis';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const app = express();
const PORT = process.env.PORT || 5001;
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || '0912795c6a321a033081b1cb0ebf70bcb3f7139410a7f08cacda7fe022905b8d@group.calendar.google.com';
const DOCTOR_EMAIL = process.env.DOCTOR_EMAIL || 'gyromotion.physio@gmail.com';
const CLINIC_ADDRESS = process.env.CLINIC_ADDRESS || 'Plot Number 1, Shree Siddhivinayak society, Near Pawar Hospital, front Of Lotus Computers, Vatan Nagar, Talegaon Dabhade, Pune 410507';
const CLINIC_WHATSAPP = process.env.CLINIC_WHATSAPP || '919518554022';
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL || '';

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend files from gyromotion-website
app.use(express.static(path.resolve(__dirname, '..')));

// Multer storage for uploaded investigations
const uploadDir = path.resolve(__dirname, '../uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    cb(null, `${Date.now()}-${safeName}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB max
});

// Load Google Service Account
let serviceAccount = null;

// 1. Check environment variable (stringified JSON)
if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
  try {
    let raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON.trim();
    if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) {
      raw = raw.slice(1, -1);
    }
    serviceAccount = JSON.parse(raw);
    console.log('✓ Loaded service account from GOOGLE_SERVICE_ACCOUNT_JSON environment variable');
  } catch (err) {
    console.error('Error parsing GOOGLE_SERVICE_ACCOUNT_JSON env var:', err.message);
  }
}

// 2. Check candidate file paths
if (!serviceAccount) {
  const candidatePaths = [
    path.resolve(__dirname, 'service-account.json'),
    path.resolve(__dirname, '../service-account.json'),
    '/etc/secrets/service-account.json', // Render secret file default
    '/opt/render/project/src/service-account.json',
    '/opt/render/project/src/server/service-account.json',
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY
  ].filter(Boolean);

  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      try {
        serviceAccount = JSON.parse(fs.readFileSync(p, 'utf8'));
        console.log('✓ Loaded service account from file:', p);
        break;
      } catch (e) {
        console.error('Failed reading service account from', p, e.message);
      }
    }
  }

  if (!serviceAccount) {
    console.warn('Warning: Google Service Account not found. Checked paths:', candidatePaths);
  }
}

// Health & Status check endpoint
app.get('/api/status', (req, res) => {
  res.json({
    status: 'ok',
    calendarConfigured: !!serviceAccount,
    serviceAccountEmail: serviceAccount ? serviceAccount.client_email : null,
    calendarId: CALENDAR_ID,
    emailConfigured: !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD)
  });
});

// Google Calendar API client
function getCalendarClient() {
  if (!serviceAccount) return null;
  const auth = new google.auth.JWT({
    email: serviceAccount.client_email,
    key: serviceAccount.private_key,
    scopes: ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/calendar.events']
  });
  return google.calendar({ version: 'v3', auth });
}

// Nodemailer Transporter
function getEmailTransporter() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD ? process.env.GMAIL_APP_PASSWORD.replace(/\s+/g, '') : '';
  if (!user || !pass) {
    console.warn('Warning: GMAIL_USER or GMAIL_APP_PASSWORD not set');
    return null;
  }
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass }
  });
}

// Helper: Generate Google Meet Link
function generateMeetLink() {
  if (process.env.DEFAULT_MEET_LINK && process.env.DEFAULT_MEET_LINK.includes('meet.google.com')) {
    return process.env.DEFAULT_MEET_LINK;
  }
  const part1 = Math.random().toString(36).substring(2, 5);
  const part2 = Math.random().toString(36).substring(2, 6);
  const part3 = Math.random().toString(36).substring(2, 5);
  return `https://meet.google.com/${part1}-${part2}-${part3}`;
}

// -------------------------------------------------------------
// API: GET /api/appointments?date=YYYY-MM-DD
// Queries Google Calendar directly for real-time slot blocking
// -------------------------------------------------------------
app.get('/api/appointments', async (req, res) => {
  try {
    const { date } = req.query; // format: "YYYY-MM-DD"
    if (!date) {
      return res.status(400).json({ error: 'date query parameter is required (YYYY-MM-DD)' });
    }

    const calendar = getCalendarClient();
    if (!calendar) {
      return res.json({ date, bookedSlots: [] });
    }

    const startOfDay = new Date(`${date}T00:00:00+05:30`).toISOString();
    const endOfDay = new Date(`${date}T23:59:59+05:30`).toISOString();

    const calRes = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: startOfDay,
      timeMax: endOfDay,
      singleEvents: true
    });

    const bookedSlots = [];
    (calRes.data.items || []).forEach(evt => {
      if (evt.status !== 'cancelled' && evt.start?.dateTime) {
        const d = new Date(evt.start.dateTime);
        const timeSlot = d.toLocaleTimeString('en-IN', {
          timeZone: 'Asia/Kolkata',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false
        });
        if (!bookedSlots.includes(timeSlot)) {
          bookedSlots.push(timeSlot);
        }
      }
    });

    res.json({ date, bookedSlots });
  } catch (error) {
    console.error('Error fetching booked slots from calendar:', error);
    res.status(500).json({ error: 'Failed to fetch booked slots', details: error.message });
  }
});

// -------------------------------------------------------------
// API: POST /api/book-appointment
// Books appointment, blocks slot, creates calendar event, emails, and triggers SMS/WhatsApp
// -------------------------------------------------------------
app.post('/api/book-appointment', upload.array('files', 5), async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      email,
      phone,
      reason,
      appointmentType,
      date, // "YYYY-MM-DD"
      time, // "17:00"
      mode // "Offline" | "Online"
    } = req.body;

    if (!firstName || !lastName || !email || !phone || !date || !time || !mode) {
      return res.status(400).json({ error: 'All required fields must be filled.' });
    }

    // Check if the selected date is a Sunday
    const dayOfWeek = new Date(`${date}T12:00:00+05:30`).getDay();
    if (dayOfWeek === 0) {
      return res.status(400).json({
        error: 'The clinic is closed on Sundays. Please select a date between Monday and Saturday.'
      });
    }

    // Ensure phone has +91 prefix
    let cleanPhone = phone.trim();
    if (!cleanPhone.startsWith('+91')) {
      cleanPhone = `+91${cleanPhone.replace(/^0+/, '')}`;
    }

    const patientName = `${firstName} ${lastName}`.trim();
    const isOnline = mode.toLowerCase() === 'online';
    const isoDateTime = `${date}T${time}:00+05:30`;

    // Calculate end time (+30 min)
    const [startHour, startMin] = time.split(':').map(Number);
    let endHour = startHour;
    let endMin = startMin + 30;
    if (endMin >= 60) {
      endHour += Math.floor(endMin / 60);
      endMin = endMin % 60;
    }
    const endTime = `${String(endHour).padStart(2, '0')}:${String(endMin).padStart(2, '0')}`;
    const isoEndDateTime = `${date}T${endTime}:00+05:30`;

    const calendar = getCalendarClient();
    if (!calendar) {
      return res.status(500).json({ error: 'Google Calendar integration not configured.' });
    }

    // 1. Verify slot is not already booked in Google Calendar
    const startOfDay = new Date(`${date}T00:00:00+05:30`).toISOString();
    const endOfDay = new Date(`${date}T23:59:59+05:30`).toISOString();
    const existingEvents = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: startOfDay,
      timeMax: endOfDay,
      singleEvents: true
    });

    const isAlreadyBooked = (existingEvents.data.items || []).some(evt => {
      if (evt.status !== 'cancelled' && evt.start?.dateTime) {
        const d = new Date(evt.start.dateTime);
        const slot = d.toLocaleTimeString('en-IN', {
          timeZone: 'Asia/Kolkata',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false
        });
        return slot === time;
      }
      return false;
    });

    if (isAlreadyBooked) {
      return res.status(409).json({
        error: `The slot ${time} on ${date} has already been reserved. Please pick another time.`
      });
    }

    // 2. Determine Meet Link (only if Online)
    const meetLink = isOnline ? generateMeetLink() : null;

    // 3. Create Google Calendar Event
    const uploadedFilesList = req.files && req.files.length > 0
      ? req.files.map(f => f.originalname).join(', ')
      : 'None';

    const eventSummary = isOnline
      ? `[Online Video Consultation] ${patientName}`
      : `[In-Clinic] ${patientName}`;

    const description = [
      `Patient Name: ${patientName}`,
      `Phone: ${cleanPhone}`,
      `Email: ${email}`,
      `Mode: ${isOnline ? `Online Meet (${appointmentType || 'General Consultation'})` : 'Offline In Clinic'}`,
      `Reason for Consultancy: ${reason || 'N/A'}`,
      `Attached Reports: ${uploadedFilesList}`,
      isOnline ? `Google Meet Link: ${meetLink}` : `Location: ${CLINIC_ADDRESS}`,
      `Doctor: Dr. Prajakta Joshi`,
      `Contact: Available on WhatsApp`
    ].join('\n');

    const eventPayload = {
      summary: eventSummary,
      description,
      location: isOnline ? meetLink : CLINIC_ADDRESS,
      start: { dateTime: isoDateTime, timeZone: 'Asia/Kolkata' },
      end: { dateTime: isoEndDateTime, timeZone: 'Asia/Kolkata' }
    };

    const calInsertRes = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      resource: eventPayload
    });
    console.log('Google Calendar event created:', calInsertRes.data.id, calInsertRes.data.summary);

    // 4. Send Confirmation Emails via Gmail SMTP
    const transporter = getEmailTransporter();
    if (transporter) {
      const formattedDate = new Date(`${date}T00:00:00`).toLocaleDateString('en-IN', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });

      // Generate "Add to Google Calendar" link for patient
      const startIso = new Date(`${date}T${time}:00+05:30`);
      const endIso = new Date(`${date}T${endTime}:00+05:30`);
      const formatGCalDate = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
      const gcalDates = `${formatGCalDate(startIso)}/${formatGCalDate(endIso)}`;
      const gcalTitle = encodeURIComponent(`Consultation with Dr. Prajakta Joshi (Gyromotion)`);
      const gcalDetails = encodeURIComponent(
        `Doctor: Dr. Prajakta Joshi (Gyromotion Physiotherapy Clinic)\nMode: ${isOnline ? 'Online Video Meet' : 'In Clinic'}\n${isOnline && meetLink ? `Google Meet Link: ${meetLink}\n` : ''}${!isOnline ? `Address: ${CLINIC_ADDRESS}\n` : ''}WhatsApp: Connect with Dr. Prajakta on WhatsApp`
      );
      const gcalLocation = encodeURIComponent(isOnline ? (meetLink || 'Google Meet') : CLINIC_ADDRESS);
      const addToGoogleCalendarUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${gcalTitle}&dates=${gcalDates}&details=${gcalDetails}&location=${gcalLocation}`;

      // Email HTML for Patient
      const patientEmailHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 14px; overflow: hidden; background: #ffffff;">
          <div style="background-color: #041f46; color: #ffffff; padding: 26px 20px; text-align: center;">
            <h1 style="margin: 0; font-size: 22px; letter-spacing: 0.5px;">Gyromotion Physiotherapy Clinic</h1>
            <p style="margin: 6px 0 0; font-size: 14px; opacity: 0.9;">Dr. Prajakta Joshi | Appointment Confirmation</p>
          </div>
          
          <div style="padding: 28px 24px; color: #1e293b;">
            <h2 style="color: #041f46; margin-top: 0; font-size: 20px;">Hello ${patientName},</h2>
            <p style="font-size: 15px; line-height: 1.5; color: #475569;">
              Your appointment has been successfully confirmed. Below are your consultation details:
            </p>

            <div style="background-color: #f8fafc; border-left: 4px solid #041f46; padding: 16px 20px; margin: 20px 0; border-radius: 6px;">
              <p style="margin: 6px 0;"><strong>Date:</strong> ${formattedDate}</p>
              <p style="margin: 6px 0;"><strong>Time:</strong> ${time} IST</p>
              <p style="margin: 6px 0;"><strong>Consultation Mode:</strong> ${isOnline ? 'Online Video Meet' : 'Offline In Clinic'}</p>
              ${isOnline && appointmentType ? `<p style="margin: 6px 0;"><strong>Type:</strong> ${appointmentType}</p>` : ''}
              ${!isOnline ? `<p style="margin: 6px 0;"><strong>Clinic Address:</strong> ${CLINIC_ADDRESS}</p>` : ''}
            </div>

            <!-- Add to Google Calendar Button -->
            <div style="text-align: center; margin: 22px 0;">
              <a href="${addToGoogleCalendarUrl}" target="_blank" style="display: inline-block; background-color: #041f46; color: #ffffff !important; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 14px; box-shadow: 0 2px 8px rgba(4,31,70,0.2);">
                📅 Add to Google Calendar
              </a>
            </div>

            ${isOnline ? `
              <div style="background-color: #eff6ff; border: 1.5px solid #bfdbfe; padding: 20px; border-radius: 12px; text-align: center; margin: 24px 0;">
                <h3 style="margin: 0 0 6px; color: #1d4ed8; font-size: 18px;">📹 Google Meet Video Call</h3>
                <p style="margin: 0 0 16px; font-size: 14px; color: #475569;">
                  Please join using the link below at your appointment time:
                </p>
                <a href="${meetLink}" target="_blank" style="display: inline-block; background-color: #1a73e8; color: #ffffff !important; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 15px;">
                  Join Google Meet Call
                </a>
                <p style="margin: 12px 0 0; font-size: 12px; color: #64748b;">
                  Meeting Link: <a href="${meetLink}" style="color: #1a73e8;">${meetLink}</a>
                </p>
              </div>
            ` : `
              <div style="background-color: #f1f5f9; padding: 16px; border-radius: 8px; margin: 20px 0; font-size: 14px; color: #475569;">
                <strong>📍 Clinic Visit Instructions:</strong><br>
                Please arrive 5-10 minutes prior to your slot. If you have any previous MRI, X-Ray, or prescriptions, please bring them along.
              </div>
            `}

            <div style="background-color: #f0fdf4; border: 1px solid #bbf7d0; padding: 14px 18px; border-radius: 8px; margin: 20px 0; font-size: 13px; color: #166534;">
              <strong>💬 Need to change timing or reschedule?</strong><br>
              Connect with Dr. Prajakta on <a href="https://api.whatsapp.com/send?phone=${CLINIC_WHATSAPP}&text=Hi%20Dr.%20Prajakta,%20I%20have%20an%20appointment%20booked%20for%20${date}%20at%20${time}%20and%20need%20to%20change%20the%20timing" style="color: #166534; font-weight: bold;">WhatsApp</a> or visit our <a href="https://gyromotionphysio.in/about.html#contact-section" style="color: #166534; font-weight: bold;">Contact Page</a>.
            </div>

            <div style="margin-top: 24px; padding-top: 20px; border-top: 1px solid #e2e8f0; font-size: 13px; color: #64748b;">
              <p style="margin: 4px 0;"><strong>Doctor:</strong> Dr. Prajakta Joshi</p>
              <p style="margin: 4px 0;"><strong>Contact / WhatsApp:</strong> <a href="https://api.whatsapp.com/send?phone=${CLINIC_WHATSAPP}&text=Hi%20Dr.%20Prajakta" style="color: #166534; font-weight: bold;">Chat on WhatsApp</a></p>
              <p style="margin: 4px 0;"><strong>Email:</strong> <a href="mailto:${DOCTOR_EMAIL}" style="color: #041f46;">${DOCTOR_EMAIL}</a></p>
            </div>

            <!-- System-Generated Notice -->
            <div style="margin-top: 20px; padding: 12px 14px; background-color: #f1f5f9; border-radius: 8px; font-size: 12px; color: #64748b; text-align: center; border: 1px dashed #cbd5e1;">
              🤖 <em>Please Note: This is an automated, system-generated confirmation email. Replies to this email address are not monitored.</em><br>
              To reschedule or connect with the doctor, please use the WhatsApp link above.
            </div>
          </div>

          <div style="background-color: #f8fafc; padding: 12px; text-align: center; font-size: 12px; color: #94a3b8; border-top: 1px solid #e2e8f0;">
            &copy; ${new Date().getFullYear()} Gyromotion Physiotherapy Clinic. All rights reserved.
          </div>
        </div>
      `;

      // Email options for Patient
      const mailOptionsPatient = {
        from: `"Gyromotion Physiotherapy Clinic" <${process.env.GMAIL_USER}>`,
        to: email,
        subject: `Appointment Confirmed: ${patientName} - ${isOnline ? 'Online Video Meet' : 'In Clinic'} (${date} at ${time})`,
        html: patientEmailHtml
      };

      // Email options for Clinic Notification
      const attachments = req.files ? req.files.map(f => ({ filename: f.originalname, path: f.path })) : [];
      const clinicEmailHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; color: #1e293b;">
          <h2 style="color: #041f46;">New Patient Appointment Booked</h2>
          <p>A new appointment has been scheduled through the website:</p>
          <ul style="line-height: 1.8;">
            <li><strong>Patient:</strong> ${patientName}</li>
            <li><strong>Phone:</strong> ${cleanPhone}</li>
            <li><strong>Email:</strong> ${email}</li>
            <li><strong>Mode:</strong> ${isOnline ? 'Online Video Consultation' : 'Offline In Clinic'}</li>
            <li><strong>Date & Time:</strong> ${date} at ${time} IST</li>
            <li><strong>Reason:</strong> ${reason || 'Not specified'}</li>
            ${isOnline && meetLink ? `<li><strong>Google Meet Link:</strong> <a href="${meetLink}">${meetLink}</a></li>` : ''}
          </ul>
          ${attachments.length > 0 ? `<p><strong>Attached Investigations:</strong> ${attachments.map(a => a.filename).join(', ')}</p>` : ''}
          <div style="margin-top: 24px; padding: 10px 14px; background-color: #f1f5f9; border-radius: 6px; font-size: 12px; color: #64748b; border: 1px dashed #cbd5e1;">
            🤖 <em>Note: This is an automated, system-generated notification sent by Gyromotion Appointment Scheduler.</em>
          </div>
        </div>
      `;

      const mailOptionsClinic = {
        from: `"Website Appointment System" <${process.env.GMAIL_USER}>`,
        to: DOCTOR_EMAIL,
        subject: `[New Appointment] ${patientName} - ${isOnline ? 'ONLINE MEET' : 'IN CLINIC'} on ${date} at ${time}`,
        html: clinicEmailHtml,
        attachments
      };

      try {
        await Promise.all([
          transporter.sendMail(mailOptionsPatient),
          transporter.sendMail(mailOptionsClinic)
        ]);
        console.log('Confirmation emails sent to patient and clinic.');
      } catch (mailErr) {
        console.error('Error sending confirmation email:', mailErr.message);
      }
    }

    // 5. Trigger Automated SMS / WhatsApp Webhook (if configured)
    if (MAKE_WEBHOOK_URL) {
      try {
        fetch(MAKE_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event: 'appointment_booked',
            patientName,
            phone: cleanPhone,
            email,
            date,
            time,
            mode: isOnline ? 'Online' : 'Offline',
            appointmentType: isOnline ? (appointmentType || 'General Consultation') : 'In-Clinic',
            reason,
            meetLink: meetLink || '',
            clinicWhatsapp: CLINIC_WHATSAPP
          })
        }).then(res => console.log('Automated SMS/WhatsApp Webhook fired. Response:', res.status))
          .catch(err => console.warn('Webhook delivery notice:', err.message));
      } catch (webhookErr) {
        console.warn('Webhook trigger error:', webhookErr.message);
      }
    }

    res.json({
      success: true,
      message: 'Appointment booked successfully!',
      appointment: {
        patientName,
        phone: cleanPhone,
        date,
        time,
        mode: isOnline ? 'online' : 'offline',
        meetLink
      },
      meetLink,
      clinicWhatsapp: CLINIC_WHATSAPP
    });
  } catch (error) {
    console.error('Booking error:', error);
    res.status(500).json({ error: 'Failed to book appointment', details: error.message });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`Gyromotion Appointment Server running on http://localhost:${PORT}`);
});
