/**
 * Age Gate as a Service SDK - Version 0.2
 * One line for any website (with white-label branding)
 */
window.AgeGate = {
  verify: function(options = {}) {
    const { onSuccess, threshold = 18 } = options;
    const clientId = encodeURIComponent(window.location.hostname);
    const verifierUrl = `http://agegate.local:30452/api/v1/verify?client_id=${clientId}&threshold=${threshold}`;

    // Fetch branding for the current client
    fetch(`/api/v1/branding/${clientId}`)
      .then(res => res.json())
      .then(branding => showModal(branding))
      .catch(() => showModal(null));

    function showModal(branding) {
      const primaryColor = (branding && branding.primary_color) || '#0a0';
      const secondaryColor = (branding && branding.secondary_color) || '#1a1a1a';
      const logoHtml = (branding && branding.logo_url) ? `<img src="${branding.logo_url}" style="max-height:60px; margin-bottom:20px;">` : '';
      const footerHtml = (branding && branding.footer_text) ? `<p style="margin-top:20px;font-size:12px;color:#888;">${branding.footer_text}</p>` : '';

      const modalHTML = `
        <div style="position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.92);z-index:2147483647;display:flex;align-items:center;justify-content:center;color:white;font-family:system-ui,sans-serif;">
          <div style="background:${secondaryColor};padding:30px;border-radius:16px;max-width:420px;text-align:center;">
            ${logoHtml}
            <h2>Anonymous Age Verification</h2>
            <p>Scan the QR code with your phone</p>
            <img src="https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(verifierUrl)}" style="margin:15px 0;border:8px solid #0a0;border-radius:8px;">
            <button onclick="this.closest('.agegate-modal').remove(); AgeGate._simulateSuccess()"
                    style="margin-top:20px;padding:14px 32px;background:${primaryColor};color:white;border:none;border-radius:10px;font-size:16px;cursor:pointer;">
              I have verified (TEST)
            </button>
            ${footerHtml}
          </div>
        </div>`;

      const modal = document.createElement('div');
      modal.className = 'agegate-modal';
      modal.innerHTML = modalHTML;
      document.body.appendChild(modal);

      AgeGate._simulateSuccess = function() {
        modal.remove();
        const result = { verified: true, age: 25, threshold: threshold, timestamp: new Date().toISOString() };
        if (onSuccess) onSuccess(result);
        else alert("✅ Age successfully verified");
      };
    }
  }
};
