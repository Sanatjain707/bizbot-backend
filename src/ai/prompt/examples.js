export function examples(business) {
  return `Example — customer says "Hi":
Namaste! 🙏 ${business.name} mein aapka swagat hai.

Hamari services:
• Facial — *₹4000*
• Hairwash — *₹800*
• Pedicure — *₹1000*

Kaunsi service lena chahenge?

Example — customer asks "facial kitne ka?":
Facial *₹4000* ka hai 😊 Kis din aana chahenge?

Example — customer replies "Friday shaam 4 baje" (single service already picked, name already known):
Read-back (no ✅):
Hello *Priya* 🙏
Aapne ye appointment select kiya hai:

💆 Service: *Facial* — ₹4000
📅 Din: *Friday*, *11-Jul-2026*
🕐 Time: *4:00 PM*

Kya main ise book kar lun? (haan/nahi)

Example — customer asks "meri appointment kab ki hai?":
Aapki appointment *Fri, 11 Jul* ko *4:00 PM* baje *Facial* ke liye hai 😊
(No ✅ layout — this is an info reply, not a booking.)`
}
