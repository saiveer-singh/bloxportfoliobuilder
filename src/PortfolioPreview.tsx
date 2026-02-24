import { motion } from "framer-motion";

function sanitizeFontName(name: string): string {
  return name.replace(/[^a-zA-Z0-9 -]/g, "");
}

function isAllowedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

type GeneratedPortfolio = {
  headline: string;
  elevatorPitch: string;
  about: string;
  skills: string[];
  highlightedProjects: Array<{
    name: string;
    summary: string;
    stack: string[];
    impact: string;
    imageUrl?: string;
    gameUrl?: string;
  }>;
  sectionBlocks: Array<{ title: string; body: string }>;
  theme?: {
    bg: string;
    bgSurface: string;
    ink: string;
    accent: string;
    fontBody: string;
    fontDisplay: string;
    radius: string;
  };
  cta: string;
};

export function PortfolioPreview({ data }: { data: GeneratedPortfolio }) {
  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: { staggerChildren: 0.15, delayChildren: 0.2 },
    },
  };

  const itemVariants = {
    hidden: { opacity: 0, y: 50, filter: "blur(10px)" },
    visible: {
      opacity: 1,
      y: 0,
      filter: "blur(0px)",
      transition: { duration: 0.8 }
    },
  };

  // Sanitize font names to prevent CSS injection
  const safeFontBody = data.theme
    ? sanitizeFontName(data.theme.fontBody)
    : "";
  const safeFontDisplay = data.theme
    ? sanitizeFontName(data.theme.fontDisplay)
    : "";

  // Calculate Google Fonts URL based on the theme
  const fontUrl = data.theme
    ? `https://fonts.googleapis.com/css2?family=${safeFontBody.replace(/\s+/g, "+")}:wght@300;400;500;600;700&family=${safeFontDisplay.replace(/\s+/g, "+")}:wght@400;500;600;700;800&display=swap`
    : "";

  // Sanitize CSS values to prevent injection
  const sanitizeCss = (v: string) => v.replace(/[;{}()<>\\/"'`]/g, "");

  const dynamicStyles = data.theme
    ? {
      "--bg": sanitizeCss(data.theme.bg),
      "--bg-surface": sanitizeCss(data.theme.bgSurface),
      "--ink": sanitizeCss(data.theme.ink),
      "--accent": sanitizeCss(data.theme.accent),
      "--font-body": `"${safeFontBody}", ui-sans-serif, system-ui, sans-serif`,
      "--font-display": `"${safeFontDisplay}", sans-serif`,
      "--radius-sm": sanitizeCss(data.theme.radius),
      "--radius-md": sanitizeCss(data.theme.radius),
      "--radius-lg": sanitizeCss(data.theme.radius),
    } as React.CSSProperties
    : {};

  return (
    <>
      {data.theme && (
        <style>
          {`@import url('${fontUrl}');`}
        </style>
      )}
      <motion.div
        className="site-preview-container"
        initial="hidden"
        animate="visible"
        variants={containerVariants}
        style={dynamicStyles}
      >
        <motion.header className="site-preview-header" variants={itemVariants}>
          <div className="site-preview-logo">PORTFOLIO</div>
          <nav className="site-preview-nav">
            <a href="#about">About</a>
            <a href="#projects">Work</a>
            <a href="#skills">Expertise</a>
          </nav>
        </motion.header>

        <motion.section className="site-preview-hero" variants={itemVariants}>
          <motion.h1
            className="site-preview-headline"
            initial={{ opacity: 0, x: -50 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 1, ease: "easeOut", delay: 0.4 }}
          >
            {data.headline}
          </motion.h1>
          <motion.p
            className="site-preview-pitch"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 1, delay: 0.8 }}
          >
            {data.elevatorPitch}
          </motion.p>
        </motion.section>

        <motion.section id="about" className="site-preview-section site-preview-about" variants={itemVariants}>
          <div className="site-preview-section-title">01 / About</div>
          <div className="site-preview-about-content">
            <p>{data.about}</p>
          </div>
        </motion.section>

        <motion.section id="projects" className="site-preview-section site-preview-projects" variants={itemVariants}>
          <div className="site-preview-section-title">02 / Selected Works</div>
          <div className="site-preview-projects-grid">
            {data.highlightedProjects.map((p, i) => (
              <motion.div
                className="site-preview-project-card"
                key={i}
                initial="hidden"
                whileInView="visible"
                viewport={{ once: true, margin: "-100px" }}
                variants={itemVariants}
                whileHover={{ scale: 1.02, transition: { duration: 0.3 } }}
              >
                {p.imageUrl && isAllowedUrl(p.imageUrl) && (
                  <div className="site-preview-project-image-container">
                    <img src={p.imageUrl} alt={p.name} className="site-preview-project-image" />
                  </div>
                )}
                <div className="site-preview-project-content-wrapper">
                  <div className="site-preview-project-meta">
                    <h3 className="site-preview-project-name">{p.name}</h3>
                    <div className="site-preview-project-stack">
                      {p.stack.map((s, j) => (
                        <span key={j}>{s}</span>
                      ))}
                    </div>
                  </div>
                  <div className="site-preview-project-details">
                    <p className="site-preview-project-summary">{p.summary}</p>
                    <p className="site-preview-project-impact">{p.impact}</p>
                    {p.gameUrl && isAllowedUrl(p.gameUrl) && (
                      <a href={p.gameUrl} target="_blank" rel="noopener noreferrer" className="site-preview-game-link">
                        [ PLAY EXPERIENCE ]
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="7" y1="17" x2="17" y2="7"></line>
                          <polyline points="7 7 17 7 17 17"></polyline>
                        </svg>
                      </a>
                    )}
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        </motion.section>

        <motion.section id="skills" className="site-preview-section site-preview-skills" variants={itemVariants}>
          <div className="site-preview-section-title">03 / Expertise</div>
          <div className="site-preview-skills-list">
            {data.skills.map((s, i) => (
              <motion.div
                className="site-preview-skill-item"
                key={i}
                initial={{ opacity: 0, scale: 0.9 }}
                whileInView={{ opacity: 1, scale: 1 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.05, duration: 0.4 }}
                whileHover={{ y: -10, transition: { duration: 0.2 } }}
              >
                {s}
              </motion.div>
            ))}
          </div>
        </motion.section>

        {data.sectionBlocks.length > 0 && (
          <motion.section className="site-preview-section site-preview-extra" variants={itemVariants}>
            <div className="site-preview-section-title">04 / More</div>
            <div className="site-preview-extra-grid">
              {data.sectionBlocks.map((b, i) => (
                <motion.div
                  className="site-preview-extra-block"
                  key={i}
                  initial="hidden"
                  whileInView="visible"
                  viewport={{ once: true }}
                  variants={itemVariants}
                >
                  <h4>{b.title}</h4>
                  <p>{b.body}</p>
                </motion.div>
              ))}
            </div>
          </motion.section>
        )}

        <motion.footer className="site-preview-footer" variants={itemVariants}>
          <h2 className="site-preview-cta">{data.cta}</h2>
          <div className="site-preview-footer-bottom">
            <span>© {new Date().getFullYear()}</span>
            <span>Available for new opportunities</span>
          </div>
        </motion.footer>
      </motion.div>
    </>
  );
}
