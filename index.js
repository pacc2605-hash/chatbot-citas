import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";
import admin from "firebase-admin";

// --- Inicializar Express ---
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// --- Firebase usando variable de entorno ---
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_KEY)),
});
const db = admin.firestore();

// --- Twilio usando variables de entorno ---
const { MessagingResponse } = twilio.twiml;
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// =====================
// DATOS BASE (mock)
// =====================
const especialidades = {
  1: { nombre: "Cardiología", medicos: ["Dr. Pérez", "Dra. Ramos"] },
  2: { nombre: "Pediatría", medicos: ["Dr. Castro", "Dra. León"] },
  3: { nombre: "Dermatología", medicos: ["Dra. Torres", "Dr. Vidal"] },
  4: { nombre: "Ginecología", medicos: ["Dra. Herrera", "Dr. Gómez"] },
};

const horariosDisponibles = [
  "Lunes 9:00 AM",
  "Martes 10:00 AM",
  "Miércoles 11:00 AM",
  "Jueves 3:00 PM",
  "Viernes 4:00 PM",
];

// =====================
// RUTA PRINCIPAL WHATSAPP
// =====================
app.post("/whatsapp", async (req, res) => {
  const incomingMsg = req.body.Body?.trim().toLowerCase();
  const from = req.body.From;
  const twiml = new MessagingResponse();
  const msg = twiml.message();

  const userRef = db.collection("usuarios").doc(from);
  const userDoc = await userRef.get();
  let userState = userDoc.exists ? userDoc.data().estado : "inicio";
  const userData = userDoc.exists ? userDoc.data() : {};

  // --- Inicio o reinicio ---
  if (incomingMsg === "hola" || userState === "inicio") {
    msg.body(
      "👋 ¡Hola! Soy tu asistente médico virtual.\n\nElige una opción:\n1️⃣ Agendar cita\n2️⃣ Ver mis citas\n3️⃣ Cancelar una cita"
    );
    await userRef.set({ estado: "menu" });
  }

  // --- Menú principal ---
  else if (userState === "menu") {
    if (incomingMsg === "1") {
      let lista = Object.entries(especialidades)
        .map(([key, esp]) => `${key}️⃣ ${esp.nombre}`)
        .join("\n");
      msg.body("🏥 Selecciona una especialidad:\n" + lista);
      await userRef.update({ estado: "elegir_especialidad" });
    } else if (incomingMsg === "2") {
      const citasSnap = await db
        .collection("citas")
        .where("usuario", "==", from)
        .where("estado", "==", "confirmada")
        .get();
      if (citasSnap.empty) {
        msg.body("📋 No tienes citas registradas.");
      } else {
        let texto = "📋 Tus citas confirmadas:\n";
        citasSnap.forEach((doc) => {
          const c = doc.data();
          texto += `• ${c.especialidad} con ${c.medico} - ${c.fecha} ${c.hora}\n`;
        });
        msg.body(texto);
      }
      await userRef.update({ estado: "menu" });
    } else if (incomingMsg === "3") {
      msg.body("🗓️ Escribe el día o especialidad de la cita que deseas cancelar:");
      await userRef.update({ estado: "cancelar_cita" });
    } else {
      msg.body("Por favor, elige una opción válida (1, 2 o 3).");
    }
  }

  // --- Elegir especialidad ---
  else if (userState === "elegir_especialidad") {
    const espSeleccionada = especialidades[incomingMsg];
    if (espSeleccionada) {
      const medicosLista = espSeleccionada.medicos
        .map((m, i) => `${i + 1}️⃣ ${m}`)
        .join("\n");
      msg.body(
        `👩‍⚕️ Has elegido *${espSeleccionada.nombre}*.\nSelecciona un médico:\n${medicosLista}`
      );
      await userRef.update({
        estado: "elegir_medico",
        especialidad: espSeleccionada.nombre,
      });
    } else {
      msg.body("Por favor, elige un número válido de especialidad.");
    }
  }

  // --- Elegir médico ---
  else if (userState === "elegir_medico") {
    const esp = Object.values(especialidades).find(
      (e) => e.nombre === userData.especialidad
    );
    const medicoSeleccionado = esp.medicos[parseInt(incomingMsg) - 1];
    if (medicoSeleccionado) {
      const horarios = horariosDisponibles
        .map((h, i) => `${i + 1}️⃣ ${h}`)
        .join("\n");
      msg.body(
        `🩺 Has elegido al *${medicoSeleccionado}*.\nSelecciona un horario disponible:\n${horarios}`
      );
      await userRef.update({
        estado: "elegir_horario",
        medico: medicoSeleccionado,
      });
    } else {
      msg.body("Por favor, elige un número válido de médico.");
    }
  }

  // --- Elegir horario ---
  else if (userState === "elegir_horario") {
    const horarioSeleccionado = horariosDisponibles[parseInt(incomingMsg) - 1];
    if (horarioSeleccionado) {
      const { especialidad, medico } = userData;

      const citasSnap = await db
        .collection("citas")
        .where("especialidad", "==", especialidad)
        .where("medico", "==", medico)
        .where("fecha", "==", horarioSeleccionado.split(" ")[0])
        .where("hora", "==", horarioSeleccionado.split(" ").slice(1).join(" "))
        .where("estado", "==", "confirmada")
        .get();

      if (!citasSnap.empty) {
        msg.body(
          `❌ Ese horario ya está ocupado para ${especialidad} con ${medico}. Por favor elige otro.`
        );
      } else {
        const nuevaCita = {
          usuario: from,
          especialidad,
          medico,
          fecha: horarioSeleccionado.split(" ")[0],
          hora: horarioSeleccionado.split(" ").slice(1).join(" "),
          estado: "confirmada",
          creada_en: admin.firestore.FieldValue.serverTimestamp(),
        };
        await db.collection("citas").add(nuevaCita);
        msg.body(
          `✅ Cita confirmada:\nEspecialidad: ${especialidad}\nMédico: ${medico}\nHorario: ${horarioSeleccionado}\n\nEscribe "hola" para volver al menú.`
        );
        await userRef.update({ estado: "menu" });
      }
    } else {
      msg.body("Por favor, elige un número válido de horario.");
    }
  }

  // --- Cancelar cita ---
  else if (userState === "cancelar_cita") {
    const citasSnap = await db
      .collection("citas")
      .where("usuario", "==", from)
      .where("estado", "==", "confirmada")
      .get();

    if (citasSnap.empty) {
      msg.body("No tienes citas para cancelar.");
      await userRef.update({ estado: "menu" });
    } else {
      let cancelada = false;
      for (const doc of citasSnap.docs) {
        const c = doc.data();
        if (
          incomingMsg.includes(c.fecha.toLowerCase()) ||
          incomingMsg.includes(c.especialidad.toLowerCase())
        ) {
          await doc.ref.update({ estado: "cancelada" });
          msg.body(`🗑️ Tu cita de ${c.especialidad} el ${c.fecha} fue cancelada.`);
          cancelada = true;
          break;
        }
      }
      if (!cancelada) {
        msg.body("No encontré una cita que coincida con lo que escribiste.");
      }
      await userRef.update({ estado: "menu" });
    }
  }

  // --- Default ---
  else {
    msg.body('No entendí tu mensaje. Escribe "hola" para comenzar.');
    await userRef.set({ estado: "inicio" });
  }

  res.writeHead(200, { "Content-Type": "text/xml" });
  res.end(twiml.toString());
});

// --- Puerto ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor WhatsApp en puerto ${PORT}`));
