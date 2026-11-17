// Which backend this copy of the site talks to.
//   Cloudflare:  { api: '/api' }
//   GoDaddy:     { api: 'api.php?r=' }   (the GoDaddy build script writes this)
//   Demo:        { demo: true }          (everything stays in this browser — for showing it off)
window.ORDER_SITE = { api: '/api' };
