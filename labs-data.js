/* labs-data.js - the lab directory and a few settings. EDIT THIS FILE.
 *
 * Add "tags" (exact techniques, e.g. "EMG", "EEG", "signal processing") so the Signal Lab can point students to related labs.
 * Every entry below is a DEMO placeholder (fake names, fake papers, no real contact info).
 * The app marks `demo: true` entries as demos and will NOT build a draft email for them.
 *
 * To add a REAL lab: only after that lab has agreed to be listed. Copy an entry, set demo: false,
 * and fill in `contact` with the address they asked students to use.
 */
window.NP_CONFIG = {
  // Where labs go to opt in. Set ONE of these when you are ready (leave both "" until then).
  optInFormUrl: "",          // e.g. a Google Form link
  optInEmail: "",            // e.g. your project email
  appName: "NeuroPath",
};

window.NP_LABS = [
  {
    id: "demo-1", demo: true, tags: ["attention", "behavioral tasks", "cognitive neuroscience"],
    pi: "Dr. Alex Placeholder", lab: "Demo Attention Lab", institution: "Example University", state: "FL",
    department: "Psychology",
    keywords: "sustained attention; mind wandering; vigilance",
    summary: "DEMO: studies lapses of sustained attention and mind wandering in healthy adults.",
    methods: "behavioral tasks; SART; R; python",
    paper: "DEMO: Lapses of sustained attention", paperYear: 2024,
    format: "either", minGrade: "sophomore", skills: "python, data analysis", contact: "",
  },
  {
    id: "demo-2", demo: true, tags: ["EMG", "EEG", "signal processing", "prosthetics", "brain-computer interface"],
    pi: "Dr. Jordan Sample", lab: "Demo Neural Interfaces Lab", institution: "Demo Institute of Technology", state: "MA",
    department: "Biomedical Engineering",
    keywords: "brain-computer interface; EMG; EEG; neural decoding; prosthetics",
    summary: "DEMO: builds noninvasive brain-computer interfaces and EMG-driven assistive devices.",
    methods: "EEG; EMG; signal processing; python; hardware prototyping",
    paper: "DEMO: EMG decoding for assistive control", paperYear: 2025,
    format: "remote", minGrade: "junior", skills: "python, signal processing", contact: "",
  },
  {
    id: "demo-3", demo: true, tags: ["EEG", "neuroimaging", "memory", "sleep"],
    pi: "Dr. Casey Fakename", lab: "Demo Memory Lab", institution: "Test State University", state: "CA",
    department: "Cognitive Neuroscience",
    keywords: "memory; hippocampus; sleep; consolidation",
    summary: "DEMO: investigates memory consolidation during sleep using fMRI and sleep EEG.",
    methods: "fMRI; sleep EEG; R; MATLAB",
    paper: "DEMO: Sleep and memory consolidation", paperYear: 2023,
    format: "in-person", minGrade: "junior", skills: "r, statistics", contact: "",
  },
  {
    id: "demo-4", demo: true, tags: ["eye tracking", "language", "behavioral experiments"],
    pi: "Dr. Riley Mockdata", lab: "Demo Language Lab", institution: "Sample College", state: "NY",
    department: "Cognitive Science",
    keywords: "language; psycholinguistics; reading; eye tracking",
    summary: "DEMO: examines how people read and comprehend sentences using eye tracking.",
    methods: "eye tracking; behavioral experiments; python",
    paper: "DEMO: Eye movements in reading", paperYear: 2024,
    format: "either", minGrade: "freshman", skills: "", contact: "",
  },
  {
    id: "demo-5", demo: true, tags: ["computational modeling", "decision making", "machine learning"],
    pi: "Dr. Morgan Notreal", lab: "Demo Computational Lab", institution: "Fictional University", state: "FL",
    department: "Cognitive Neuroscience",
    keywords: "computational modeling; decision making; reinforcement learning",
    summary: "DEMO: models human decision making with reinforcement learning.",
    methods: "computational modeling; python; behavioral data analysis",
    paper: "DEMO: Reinforcement learning in humans", paperYear: 2025,
    format: "remote", minGrade: "sophomore", skills: "python", contact: "",
  },
  {
    id: "demo-6", demo: true, tags: ["EMG", "motor control", "signal processing", "prosthetics", "rehabilitation"],
    pi: "Dr. Taylor Imaginary", lab: "Demo Motor Control Lab", institution: "Example Polytechnic", state: "FL",
    department: "Biomedical Engineering",
    keywords: "EMG; motor control; myoelectric prosthetics; rehabilitation",
    summary: "DEMO: studies how muscle signals can control prosthetic hands, including threshold and proportional control.",
    methods: "surface EMG; signal processing; python; embedded systems",
    paper: "DEMO: Proportional myoelectric control", paperYear: 2025,
    format: "either", minGrade: "freshman", skills: "signal processing", contact: "",
  },
];

// Public places where anyone can start real work without asking permission.
window.NP_RESOURCES = [
  { name: "PhysioNet", url: "https://physionet.org", note: "Open EMG, EEG and ECG recordings. Try your pipeline on real data." },
  { name: "OpenNeuro", url: "https://openneuro.org", note: "Open EEG and neuroimaging datasets from published studies." },
  { name: "Allen Brain Map", url: "https://portal.brain-map.org", note: "Open brain data, atlases and tools." },
  { name: "Zooniverse", url: "https://www.zooniverse.org", note: "Citizen-science projects you can contribute to today." },
  { name: "OpenAlex", url: "https://openalex.org", note: "Free index of papers and authors for reading the literature." },
];
