(() => {
  let disposers = [];

  function KawaicordSettingsPage() {
    const container = document.createElement('div');

    if (typeof window.kawaicordRenderSettingsPage === 'function') {
      window.kawaicordRenderSettingsPage(container);
    } else {
      container.textContent = 'Kawaicord settings renderer unavailable.';
      container.style.padding = '16px';
      container.style.color = 'var(--text-normal, #fff)';
    }

    return container;
  }

  return {
    onLoad() {
      const registerSection = shelter?.settings?.registerSection;
      if (typeof registerSection !== 'function') {
        console.error('[Kawaicord Settings] shelter.settings.registerSection unavailable');
        return;
      }

      disposers = [
        registerSection('divider'),
        registerSection('header', 'Kawaicord'),
        registerSection('section', 'kawaicord-settings', 'Settings', KawaicordSettingsPage)
      ].filter((fn) => typeof fn === 'function');

      if (typeof shelter?.util?.log === 'function') {
        shelter.util.log('Kawaicord Settings');
      }
      console.log('[Kawaicord Settings] Registered settings section');
    },

    onUnload() {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          // no-op
        }
      }
      disposers = [];
    }
  };
})()