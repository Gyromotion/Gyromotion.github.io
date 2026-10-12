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

// Load Google Service Account helper
let serviceAccount = null;

function loadServiceAccount() {
  if (serviceAccount) return serviceAccount;

  // 1. Check environment variable (stringified JSON)
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    try {
      let raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON.trim();
      if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) {
        raw = raw.slice(1, -1);
      }
      serviceAccount = JSON.parse(raw);
      if (serviceAccount.private_key) {
        serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
      }
      console.log('✓ Loaded service account from GOOGLE_SERVICE_ACCOUNT_JSON environment variable');
      return serviceAccount;
    } catch (err) {
      console.error('Error parsing GOOGLE_SERVICE_ACCOUNT_JSON env var:', err.message);
    }
  }

  // 2. Check candidate file paths
  const candidatePaths = [
    path.resolve(__dirname, 'service-account.json'),
    path.resolve(__dirname, '../service-account.json'),
    '/etc/secrets/service-account.json', // Render secret file default mount path
    '/opt/render/project/src/service-account.json',
    '/opt/render/project/src/server/service-account.json',
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY
  ].filter(Boolean);

  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      try {
        serviceAccount = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (serviceAccount.private_key) {
          serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
        }
        console.log('✓ Loaded service account from file:', p);
        return serviceAccount;
      } catch (e) {
        console.error('Failed reading service account from', p, e.message);
      }
    }
  }

  return null;
}

// Initial attempt to load service account
loadServiceAccount();

// Health & Status check endpoint
app.get('/api/status', (req, res) => {
  const sa = loadServiceAccount();
  res.json({
    status: 'ok',
    calendarConfigured: !!sa,
    serviceAccountEmail: sa ? sa.client_email : null,
    calendarId: CALENDAR_ID,
    emailConfigured: !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD)
  });
});

// Google Calendar API client
function getCalendarClient() {
  const sa = loadServiceAccount();
  if (!sa) return null;
  const auth = new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/calendar.events']
  });
  return google.calendar({ version: 'v3', auth });
}

// Nodemailer Transporter with direct SMTP and timeout protection
function getEmailTransporter() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD ? process.env.GMAIL_APP_PASSWORD.replace(/\s+/g, '') : '';
  if (!user || !pass) {
    console.warn('Warning: GMAIL_USER or GMAIL_APP_PASSWORD not set');
    return null;
  }
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user, pass },
    connectionTimeout: 10000, // 10s max connection timeout
    greetingTimeout: 5000,
    socketTimeout: 15000 // 15s max socket timeout
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
// RFC 5545 iCalendar (.ics) Generator with 30-Minute Alarm
// -------------------------------------------------------------
function generateIcsInvite({ uid, summary, description, location, start, end, organizerEmail, attendeeEmail, attendeeName }) {
  const formatDateIcs = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const nowStr = formatDateIcs(new Date());
  const startStr = formatDateIcs(start);
  const endStr = formatDateIcs(end);

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Gyromotion Clinic//Appointment Scheduler//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${uid}@gyromotionphysio.in`,
    `DTSTAMP:${nowStr}`,
    `DTSTART:${startStr}`,
    `DTEND:${endStr}`,
    `SUMMARY:${summary}`,
    `DESCRIPTION:${description.replace(/\n/g, '\\n')}`,
    `LOCATION:${location}`,
    `ORGANIZER;CN="Dr. Prajakta Joshi":mailto:${organizerEmail}`,
    `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN="${attendeeName}":mailto:${attendeeEmail}`,
    'STATUS:CONFIRMED',
    'BEGIN:VALARM',
    'TRIGGER:-PT30M',
    'ACTION:DISPLAY',
    'DESCRIPTION:Appointment with Dr. Prajakta Joshi in 30 minutes',
    'END:VALARM',
    'BEGIN:VALARM',
    'TRIGGER:-PT30M',
    'ACTION:EMAIL',
    'DESCRIPTION:Appointment with Dr. Prajakta Joshi in 30 minutes',
    `SUMMARY:Reminder: Appointment in 30 minutes`,
    `ATTENDEE:mailto:${attendeeEmail}`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');
}

// -------------------------------------------------------------
// Persistent Appointments Storage (appointments.json)
// -------------------------------------------------------------
const APPOINTMENTS_FILE = path.resolve(__dirname, 'appointments.json');

function loadStoredAppointments() {
  try {
    if (fs.existsSync(APPOINTMENTS_FILE)) {
      return JSON.parse(fs.readFileSync(APPOINTMENTS_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Error reading appointments.json:', err.message);
  }
  return [];
}

function saveStoredAppointments(list) {
  try {
    fs.writeFileSync(APPOINTMENTS_FILE, JSON.stringify(list, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving appointments.json:', err.message);
  }
}

// -------------------------------------------------------------
// Persistent Email Logs (email-logs.json)
// -------------------------------------------------------------
const EMAIL_LOGS_FILE = path.resolve(__dirname, 'email-logs.json');

function logEmailSent({ type, to, subject, status, messageId, error }) {
  try {
    let logs = [];
    if (fs.existsSync(EMAIL_LOGS_FILE)) {
      logs = JSON.parse(fs.readFileSync(EMAIL_LOGS_FILE, 'utf8'));
    }
    const now = new Date();
    logs.unshift({
      timestamp: now.toISOString(),
      timeIST: now.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true }),
      dateIST: now.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }),
      type,
      to,
      subject,
      status, // 'SUCCESS' | 'FAILED'
      messageId: messageId || null,
      error: error || null
    });
    if (logs.length > 100) logs = logs.slice(0, 100);
    fs.writeFileSync(EMAIL_LOGS_FILE, JSON.stringify(logs, null, 2), 'utf8');
  } catch (e) {
    console.error('Error recording email log:', e.message);
  }
}

// -------------------------------------------------------------
// Automated 30-Minute Advance Reminder Scheduler
// -------------------------------------------------------------
async function checkUpcomingReminders() {
  const appointments = loadStoredAppointments();
  if (!appointments || appointments.length === 0) return;

  const now = Date.now();
  let updated = false;

  for (const apt of appointments) {
    if (apt.reminder30MinSent) continue;

    try {
      // Parse appointment datetime in IST (+05:30)
      const aptTime = new Date(`${apt.date}T${apt.time}:00+05:30`).getTime();
      const diffMinutes = Math.round((aptTime - now) / (60 * 1000));

      // Trigger if within 30 minutes (between -10 and 32 minutes from now)
      if (diffMinutes <= 30 && diffMinutes >= -10) {
        console.log(`⏰ Sending 30-minute reminder for ${apt.patientName} (${apt.time} IST, diff: ${diffMinutes}m)`);
        const transporter = getEmailTransporter();
        if (transporter) {
          const isOnline = apt.mode && apt.mode.toLowerCase() === 'online';

          // Reminder email to Patient
          const patientReminderSubject = `⏰ Reminder: Consultation with Dr. Prajakta Joshi in 30 minutes (${apt.time} IST)`;
          const patientReminderText = `Hello ${apt.patientName},\n\nYour consultation with Dr. Prajakta Joshi begins in 30 minutes at ${apt.time} IST (${isOnline ? 'Online Video Meet' : 'In Clinic'}).\n\n${isOnline && apt.meetLink ? `Google Meet Link: ${apt.meetLink}\n` : ''}${!isOnline ? `Clinic Location: ${CLINIC_ADDRESS}\n` : ''}\nDoctor: Dr. Prajakta Joshi\nWhatsApp Support: https://api.whatsapp.com/send?phone=${CLINIC_WHATSAPP}\n\nGyromotion Physiotherapy Clinic`;
          const patientReminderHtml = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 14px; overflow: hidden; background: #ffffff;">
              <div style="background-color: #041f46; color: #ffffff; padding: 22px 20px; text-align: center;">
                <h1 style="margin: 0; font-size: 20px;">Gyromotion Physiotherapy Clinic</h1>
                <p style="margin: 6px 0 0; font-size: 13px; opacity: 0.9;">Dr. Prajakta Joshi | 30-Minute Consultation Reminder</p>
              </div>
              <div style="padding: 24px; color: #1e293b;">
                <h2 style="color: #041f46; margin-top: 0; font-size: 18px;">Hello ${apt.patientName},</h2>
                <p style="font-size: 15px; color: #334155; line-height: 1.5;">
                  Your appointment with Dr. Prajakta Joshi begins in <strong>30 minutes</strong> at <strong>${apt.time} IST</strong>.
                </p>
                <div style="background-color: #f8fafc; border-left: 4px solid #041f46; padding: 14px 18px; margin: 18px 0; border-radius: 6px;">
                  <p style="margin: 4px 0;"><strong>Date:</strong> ${apt.date}</p>
                  <p style="margin: 4px 0;"><strong>Time:</strong> ${apt.time} IST</p>
                  <p style="margin: 4px 0;"><strong>Mode:</strong> ${isOnline ? 'Online Video Meet' : 'Offline In Clinic'}</p>
                  ${!isOnline ? `<p style="margin: 4px 0;"><strong>Location:</strong> ${CLINIC_ADDRESS}</p>` : ''}
                </div>
                ${isOnline && apt.meetLink ? `
                  <div style="text-align: center; margin: 22px 0;">
                    <a href="${apt.meetLink}" target="_blank" style="background-color: #1a73e8; color: #ffffff !important; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 15px; display: inline-block;">
                      📹 Join Google Meet Now
                    </a>
                    <p style="margin: 8px 0 0; font-size: 12px; color: #64748b;">Link: ${apt.meetLink}</p>
                  </div>
                ` : `
                  <p style="font-size: 13px; color: #64748b; margin: 12px 0;">Please arrive 5-10 minutes prior to your slot.</p>
                `}
                <div style="margin-top: 20px; padding: 12px; background-color: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; font-size: 13px; color: #166534;">
                  💬 Running late or need assistance? Chat with Dr. Prajakta on <a href="https://api.whatsapp.com/send?phone=${CLINIC_WHATSAPP}&text=Hi%20Dr.%20Prajakta" style="color: #166534; font-weight: bold;">WhatsApp</a>.
                </div>
              </div>
            </div>
          `;

          // Reminder email to Doctor
          const clinicReminderSubject = `⏰ [30-Min Alert] Upcoming Patient: ${apt.patientName} at ${apt.time} IST`;
          const clinicReminderText = `Upcoming Consultation in 30 Minutes:\nPatient: ${apt.patientName}\nPhone: ${apt.phone}\nTime: ${apt.time} IST\nMode: ${isOnline ? 'Online Video Meet' : 'In Clinic'}\n${isOnline && apt.meetLink ? `Google Meet: ${apt.meetLink}` : ''}`;
          const clinicReminderHtml = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; color: #1e293b;">
              <h2 style="color: #041f46;">Consultation in 30 Minutes</h2>
              <ul style="line-height: 1.8;">
                <li><strong>Patient:</strong> ${apt.patientName}</li>
                <li><strong>Phone:</strong> ${apt.phone}</li>
                <li><strong>Email:</strong> ${apt.email}</li>
                <li><strong>Time:</strong> ${apt.time} IST</li>
                <li><strong>Mode:</strong> ${isOnline ? 'Online Video Meet' : 'In Clinic'}</li>
                ${isOnline && apt.meetLink ? `<li><strong>Google Meet:</strong> <a href="${apt.meetLink}">${apt.meetLink}</a></li>` : ''}
              </ul>
            </div>
          `;

          try {
            const prRes = await transporter.sendMail({
              from: `"Gyromotion Physiotherapy Clinic" <${process.env.GMAIL_USER}>`,
              to: apt.email,
              replyTo: DOCTOR_EMAIL,
              subject: patientReminderSubject,
              text: patientReminderText,
              html: patientReminderHtml
            });
            logEmailSent({ type: '30-Min Reminder (Patient)', to: apt.email, subject: patientReminderSubject, status: 'SUCCESS', messageId: prRes.messageId });
          } catch (prErr) {
            console.error('Error sending patient reminder email:', prErr.message);
            logEmailSent({ type: '30-Min Reminder (Patient)', to: apt.email, subject: patientReminderSubject, status: 'FAILED', error: prErr.message });
          }

          try {
            const drRes = await transporter.sendMail({
              from: `"Website Appointment System" <${process.env.GMAIL_USER}>`,
              to: DOCTOR_EMAIL,
              replyTo: apt.email,
              subject: clinicReminderSubject,
              text: clinicReminderText,
              html: clinicReminderHtml
            });
            logEmailSent({ type: '30-Min Reminder (Doctor)', to: DOCTOR_EMAIL, subject: clinicReminderSubject, status: 'SUCCESS', messageId: drRes.messageId });
          } catch (drErr) {
            console.error('Error sending doctor reminder email:', drErr.message);
            logEmailSent({ type: '30-Min Reminder (Doctor)', to: DOCTOR_EMAIL, subject: clinicReminderSubject, status: 'FAILED', error: drErr.message });
          }

          console.log(`✓ 30-minute reminder emails dispatched for ${apt.patientName}`);
        }

        apt.reminder30MinSent = true;
        updated = true;
      }
    } catch (e) {
      console.error('Error in 30-min reminder check:', e.message);
    }
  }

  if (updated) {
    saveStoredAppointments(appointments);
  }
}

// Start recurring 60-second reminder scheduler and run on startup
setInterval(checkUpcomingReminders, 60 * 1000);
setTimeout(checkUpcomingReminders, 5000);

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

    // Determine Meet Link (only if Online, accept client-generated or generate fresh)
    const meetLink = isOnline ? (req.body.meetLink || generateMeetLink()) : null;

    // -------------------------------------------------------------
    // RUN PARALLEL TASKS (Emails, Calendar, Webhook)
    // Run while HTTP request is in-flight so Render provides 100% full CPU!
    // (User is already looking at the Done screen on the website).
    // -------------------------------------------------------------
    // 1. Send Confirmation Emails via Gmail SMTP (Immediate top priority)
    const emailTask = (async () => {
      try {
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

          // Generate RFC 5545 ICS calendar invite with 30-minute reminder
          const icsInviteData = generateIcsInvite({
            uid: `apt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
            summary: `Consultation with Dr. Prajakta Joshi (${isOnline ? 'Online Meet' : 'In Clinic'})`,
            description: `Doctor: Dr. Prajakta Joshi (Gyromotion Physiotherapy Clinic)\nMode: ${isOnline ? 'Online Video Meet' : 'In Clinic'}\n${isOnline && meetLink ? `Google Meet Link: ${meetLink}\n` : ''}${!isOnline ? `Address: ${CLINIC_ADDRESS}\n` : ''}WhatsApp: https://api.whatsapp.com/send?phone=${CLINIC_WHATSAPP}`,
            location: isOnline ? (meetLink || 'Google Meet') : CLINIC_ADDRESS,
            start: startIso,
            end: endIso,
            organizerEmail: DOCTOR_EMAIL,
            attendeeEmail: email,
            attendeeName: patientName
          });

          // Email plain-text fallback for Patient
          const patientEmailText = `Hello ${patientName},\n\nYour appointment with Dr. Prajakta Joshi has been successfully confirmed!\n\nAppointment Details:\n- Date: ${formattedDate}\n- Time: ${time} IST\n- Consultation Mode: ${isOnline ? 'Online Video Meet' : 'Offline In Clinic'}\n${isOnline && appointmentType ? `- Type: ${appointmentType}\n` : ''}${isOnline && meetLink ? `- Google Meet Link: ${meetLink}\n` : ''}${!isOnline ? `- Clinic Address: ${CLINIC_ADDRESS}\n` : ''}\nA 30-minute advance calendar invite is attached to this email.\n\nNeed to reschedule? Connect on WhatsApp: https://api.whatsapp.com/send?phone=${CLINIC_WHATSAPP}\n\n🤖 Note: This is an automated system-generated confirmation email.\nGyromotion Physiotherapy Clinic`;

          // Email options for Patient
          const mailOptionsPatient = {
            from: `"Gyromotion Physiotherapy Clinic" <${process.env.GMAIL_USER}>`,
            to: email,
            replyTo: DOCTOR_EMAIL,
            subject: `Appointment Confirmed: ${patientName} - ${isOnline ? 'Online Video Meet' : 'In Clinic'} (${date} at ${time})`,
            text: patientEmailText,
            html: patientEmailHtml,
            attachments: [
              {
                filename: 'appointment-invite.ics',
                content: icsInviteData,
                contentType: 'text/calendar; charset=utf-8; method=REQUEST'
              }
            ]
          };

          // Email plain-text fallback for Clinic
          const clinicEmailText = `New Patient Appointment Booked:\n\n- Patient: ${patientName}\n- Phone: ${cleanPhone}\n- Email: ${email}\n- Mode: ${isOnline ? 'Online Video Consultation' : 'Offline In Clinic'}\n- Date & Time: ${date} at ${time} IST\n- Reason: ${reason || 'Not specified'}\n${isOnline && meetLink ? `- Google Meet: ${meetLink}\n` : ''}\nGyromotion Website Scheduler`;

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
            replyTo: email,
            subject: `[New Appointment] ${patientName} - ${isOnline ? 'ONLINE MEET' : 'IN CLINIC'} on ${date} at ${time}`,
            text: clinicEmailText,
            html: clinicEmailHtml,
            attachments
          };

          // Send emails with separate try/catches so neither blocks the other
          let patientSent = false;
          let clinicSent = false;

          try {
            const pRes = await transporter.sendMail(mailOptionsPatient);
            patientSent = true;
            console.log(`✓ Patient confirmation email sent to ${email} (MessageId: ${pRes.messageId})`);
            logEmailSent({ type: 'Confirmation (Patient)', to: email, subject: mailOptionsPatient.subject, status: 'SUCCESS', messageId: pRes.messageId });
          } catch (pErr) {
            console.error(`Error sending patient email to ${email}:`, pErr.message);
            logEmailSent({ type: 'Confirmation (Patient)', to: email, subject: mailOptionsPatient.subject, status: 'FAILED', error: pErr.message });
          }

          try {
            const cRes = await transporter.sendMail(mailOptionsClinic);
            clinicSent = true;
            console.log(`✓ Clinic alert email sent to ${DOCTOR_EMAIL} (MessageId: ${cRes.messageId})`);
            logEmailSent({ type: 'Alert (Doctor)', to: DOCTOR_EMAIL, subject: mailOptionsClinic.subject, status: 'SUCCESS', messageId: cRes.messageId });
          } catch (cErr) {
            console.error(`Error sending clinic alert email to ${DOCTOR_EMAIL}:`, cErr.message);
            logEmailSent({ type: 'Alert (Doctor)', to: DOCTOR_EMAIL, subject: mailOptionsClinic.subject, status: 'FAILED', error: cErr.message });
          }
        } else {
          console.warn('⚠️ Nodemailer not configured. Skipped confirmation emails.');
        }
      } catch (mailErr) {
        console.error('Error in email sending task:', mailErr.message);
      }
    })();

    // 2. Google Calendar Event with 30-Minute Popup & Email Reminders
    const calendarTask = (async () => {
      try {
        const calendar = getCalendarClient();
        if (calendar) {
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
            end: { dateTime: isoEndDateTime, timeZone: 'Asia/Kolkata' },
            reminders: {
              useDefault: false,
              overrides: [
                { method: 'popup', minutes: 30 },
                { method: 'email', minutes: 30 }
              ]
            }
          };

          const calInsertRes = await calendar.events.insert({
            calendarId: CALENDAR_ID,
            resource: eventPayload
          });
          console.log('✓ Google Calendar event created with 30-min reminders:', calInsertRes.data.id, calInsertRes.data.summary);
        } else {
          console.warn('⚠️ Google Calendar not configured. Skipped Google Calendar event creation.');
        }
      } catch (calErr) {
        console.error('Error inserting Google Calendar event:', calErr.message);
      }
    })();

    // 3. Trigger Automated SMS / WhatsApp Webhook (runs in parallel)
    const webhookTask = (async () => {
      if (MAKE_WEBHOOK_URL) {
        try {
          const wbRes = await fetch(MAKE_WEBHOOK_URL, {
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
          });
          console.log('✓ Automated SMS/WhatsApp Webhook fired. Response status:', wbRes.status);
        } catch (webhookErr) {
          console.warn('⚠️ Webhook trigger error:', webhookErr.message);
        }
      }
    })();

    // 4. Save to persistent appointments list for automated 30-minute reminder job
    try {
      const storedApts = loadStoredAppointments();
      storedApts.push({
        id: `apt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        patientName,
        phone: cleanPhone,
        email,
        date,
        time,
        mode: isOnline ? 'Online' : 'Offline',
        appointmentType: isOnline ? (appointmentType || 'General Consultation') : 'In-Clinic',
        reason: reason || '',
        meetLink: meetLink || null,
        reminder30MinSent: false,
        createdAt: new Date().toISOString()
      });
      saveStoredAppointments(storedApts);
      console.log(`✓ Appointment saved to appointments.json for 30-minute reminder tracking.`);
    } catch (storeErr) {
      console.warn('Failed to save to appointments.json:', storeErr.message);
    }

    // Wait for parallel tasks to finish with 100% active CPU allocation
    await Promise.allSettled([emailTask, calendarTask, webhookTask]);

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
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to book appointment', details: error.message });
    }
  }
});

// -------------------------------------------------------------
// Diagnostic Endpoint: Test Live Appointment Email Delivery
// GET /api/test-appointment-email?to=your_email@example.com
// -------------------------------------------------------------
app.get('/api/test-appointment-email', async (req, res) => {
  const targetEmail = req.query.to || DOCTOR_EMAIL;
  try {
    const transporter = getEmailTransporter();
    if (!transporter) return res.status(500).json({ error: 'Nodemailer not configured' });

    const testIsoStart = new Date(Date.now() + 60 * 60 * 1000);
    const testIsoEnd = new Date(Date.now() + 90 * 60 * 1000);
    const icsData = generateIcsInvite({
      uid: 'diag_' + Date.now(),
      summary: 'Diagnostic Consultation - Dr. Prajakta Joshi',
      description: `Test consultation with Dr. Prajakta Joshi\nLocation: ${CLINIC_ADDRESS}`,
      location: CLINIC_ADDRESS,
      start: testIsoStart,
      end: testIsoEnd,
      organizerEmail: DOCTOR_EMAIL,
      attendeeEmail: targetEmail,
      attendeeName: 'Test Patient'
    });

    const emailSubj = `[Diagnostic Verification] Appointment Email & 30-Min Reminder Test (${new Date().toLocaleTimeString('en-IN')})`;
    const info = await transporter.sendMail({
      from: `"Gyromotion Physiotherapy Clinic" <${process.env.GMAIL_USER}>`,
      to: targetEmail,
      replyTo: DOCTOR_EMAIL,
      subject: emailSubj,
      text: `Hello,\n\nThis is a diagnostic verification email confirming that Gyromotion's appointment mailing system, plain text alternatives, and 30-minute calendar invite attachments are operating with 100% deliverability.\n\nGyromotion Physiotherapy Clinic`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px;">
          <h2 style="color: #041f46; margin-top: 0;">✓ Diagnostic Email Verification</h2>
          <p>This email confirms that Gyromotion appointment mailing system is operating properly.</p>
          <p><strong>Recipient:</strong> ${targetEmail}</p>
          <p><strong>30-Minute Calendar Alarm Attached:</strong> Yes (appointment-invite.ics with VALARM -PT30M).</p>
        </div>
      `,
      attachments: [
        {
          filename: 'appointment-invite.ics',
          content: icsData,
          contentType: 'text/calendar; charset=utf-8; method=REQUEST'
        }
      ]
    });

    logEmailSent({ type: 'Diagnostic Test', to: targetEmail, subject: emailSubj, status: 'SUCCESS', messageId: info.messageId });

    res.json({
      success: true,
      message: 'Diagnostic appointment email sent successfully!',
      targetEmail,
      messageId: info.messageId
    });
  } catch (err) {
    logEmailSent({ type: 'Diagnostic Test', to: targetEmail, subject: 'Diagnostic Verification', status: 'FAILED', error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------------
// Endpoint: View Recent Email Logs
// GET /api/email-logs
// -------------------------------------------------------------
app.get('/api/email-logs', (req, res) => {
  try {
    let logs = [];
    if (fs.existsSync(EMAIL_LOGS_FILE)) {
      logs = JSON.parse(fs.readFileSync(EMAIL_LOGS_FILE, 'utf8'));
    }
    res.json({
      success: true,
      count: logs.length,
      logs
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`Gyromotion Appointment Server running on http://localhost:${PORT}`);
});
