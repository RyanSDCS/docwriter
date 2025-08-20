// server.js
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');
const multer = require('multer');
const ImageModule = require('docxtemplater-image-module');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Configure multer for image uploads (FIXED)
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, 'uploads');
    // Create directory synchronously if it doesn't exist
    const fs_sync = require('fs');
    if (!fs_sync.existsSync(uploadDir)) {
      fs_sync.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: function (req, file, cb) {
    if (file.mimetype === 'image/jpeg' || file.mimetype === 'image/png') {
      cb(null, true);
    } else {
      cb(new Error('Only JPG and PNG files are allowed'));
    }
  }
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Azure OpenAI Configuration
const AZURE_OPENAI_CONFIG = {
  endpoint: process.env.AZURE_OPENAI_ENDPOINT,
  apiKey: process.env.AZURE_OPENAI_API_KEY,
  deploymentName: process.env.AZURE_OPENAI_DEPLOYMENT_NAME || 'gpt-4',
  apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-02-15-preview'
};

// Document templates with AI prompts (FIXED - moved to correct location)
const DOCUMENT_TEMPLATES = {
  rca: {
    name: 'Root Cause Analysis',
    systemPrompt: `You are a technical documentation expert. Generate professional content for each section of a Root Cause Analysis document. Provide clear, concise content that can be directly inserted into each section.`,
    generatePrompt: (sections) => `
Create professional content for each section of an RCA document based on this user input:

Initial Findings: ${sections.initial_findings}
Summary: ${sections.summary}  
Timeline: ${sections.timeline}
Risk Assessment: ${sections.risk_assessment}
Conclusion: ${sections.conclusion}

Generate exactly 6 sections separated by "---" (three dashes). Each section should be 2-3 professional sentences:

[Initial findings content - expand the user's initial findings into professional analysis]
---
[Executive summary content - comprehensive summary of the incident and response]
---
[Timeline content - format as bullet points with timestamps and clear actions]
---
[Risk and impact content - analyze customer and service impact]
---
[Resolution actions content - describe immediate actions and prevention measures]
---
[Lessons learned content - process improvements and knowledge gained]

Important: 
- Provide exactly 6 sections separated by ---
- No labels or headers, just the content
- Professional technical writing style
- Each section should be substantial but concise
    `,
    docxTemplate: 'rca-template.docx'
  },
  'step-by-step-guide': {
    name: 'Step-by-Step Guide',
    systemPrompt: `You are an expert technical writer specializing in creating clear, comprehensive instructional guides. Generate professional content for step-by-step tutorials that are easy to follow and understand.`,
    generatePrompt: (sections) => `
Create professional content for a step-by-step guide based on the following information:

Guide Overview: ${sections.guide_overview}
Target Audience: ${sections.target_audience}
Prerequisites: ${sections.prerequisites}
Steps Description: ${sections.steps}
Conclusion: ${sections.conclusion}

Generate content separated by "---" (three dashes) in this exact order:

[Write 2-3 sentences expanding on the guide overview and its purpose]
---
[Write 1-2 sentences describing the target audience and skill level required]
---
[Write 1-2 sentences listing prerequisites or requirements to get started]
---
[Create a detailed breakdown of steps based on the steps description. Format as numbered steps with clear, actionable instructions. Each step should be 2-3 sentences explaining what to do and why.]
---
[Write 2-3 sentences for conclusion with summary, troubleshooting tips, or next steps]

Important: Provide only clean, professional content without labels or markdown formatting.
    `,
    docxTemplate: 'step-by-step-guide-template.docx'
  },
  'project-status': {
    name: 'Project Status Report',
    systemPrompt: `You are a project management expert. Generate professional project status reports that are clear, actionable, and provide stakeholders with essential project insights.`,
    generatePrompt: (sections) => `
Create a professional Project Status Report based on:

Executive Summary: ${sections.executive_summary}
Key Accomplishments: ${sections.accomplishments}
Challenges & Risks: ${sections.challenges}
Next Steps: ${sections.next_steps}

Generate a comprehensive project status report with proper formatting, clear headings, and professional language suitable for stakeholder consumption.
    `
  },
  'meeting-minutes': {
    name: 'Meeting Minutes',
    systemPrompt: `You are an executive assistant expert in creating professional meeting documentation. Generate clear, actionable meeting minutes that capture key decisions and follow-up items.`,
    generatePrompt: (sections) => `
Create professional meeting minutes based on:

Meeting Information: ${sections.meeting_info}
Key Discussions: ${sections.key_discussions}
Action Items: ${sections.action_items}
Next Steps: ${sections.next_steps}

Generate well-formatted meeting minutes with clear sections, action items with owners, and professional documentation standards.
    `
  }
};

// Enhanced parsing for step-by-step guides
function parseStepByStepResponse(content) {
  const parts = content.split('---');
  
  if (parts.length >= 5) {
    return {
      guide_overview: parts[0] ? parts[0].trim() : '',
      target_audience: parts[1] ? parts[1].trim() : '',
      prerequisites: parts[2] ? parts[2].trim() : '',
      steps_content: parts[3] ? parts[3].trim() : '',
      conclusion: parts[4] ? parts[4].trim() : ''
    };
  }
  
  // Fallback
  return {
    guide_overview: content,
    target_audience: 'General users',
    prerequisites: 'No specific prerequisites',
    steps_content: 'Steps not properly parsed',
    conclusion: 'Conclusion not available'
  };
}

function parseAIResponse(content) {
  console.log('=== PARSING AI RESPONSE ===');
  console.log('Raw content:', content);
  
  const sections = {};
  
  // Try to split by triple dashes (which seems to be the actual separator)
  const parts = content.split('---');
  console.log('Split into parts:', parts.length);
  
  if (parts.length >= 6) {
    // Assign parts to sections in order
    sections.initial_findings = parts[0] ? parts[0].trim() : '';
    sections.executive_summary = parts[1] ? parts[1].trim() : '';
    sections.timeline_events = parts[2] ? parts[2].trim() : '';
    sections.risk_impact = parts[3] ? parts[3].trim() : '';
    sections.resolution_actions = parts[4] ? parts[4].trim() : '';
    sections.lessons_learned = parts[5] ? parts[5].trim() : '';
  } else {
    // Fallback: split by paragraph and try to identify sections
    const paragraphs = content.split('\n\n').filter(p => p.trim());
    console.log('Fallback: paragraphs found:', paragraphs.length);
    
    if (paragraphs.length >= 6) {
      sections.initial_findings = paragraphs[0] || '';
      sections.executive_summary = paragraphs[1] || '';
      sections.timeline_events = paragraphs[2] || '';
      sections.risk_impact = paragraphs[3] || '';
      sections.resolution_actions = paragraphs[4] || '';
      sections.lessons_learned = paragraphs[5] || '';
    } else {
      // Last resort: use the whole content for each section
      sections.initial_findings = content;
      sections.executive_summary = 'Executive summary not properly parsed';
      sections.timeline_events = 'Timeline not properly parsed';
      sections.risk_impact = 'Risk assessment not properly parsed';
      sections.resolution_actions = 'Resolution actions not properly parsed';
      sections.lessons_learned = 'Lessons learned not properly parsed';
    }
  }
  
  console.log('Parsed sections:', Object.keys(sections));
  console.log('Section contents:', sections);
  
  return sections;
}

// Enhanced DOCX generation with image support
async function generateDocxFromTemplate(templateName, data, templateType = 'standard') {
  try {
    const templatePath = path.join(__dirname, 'templates', templateName);
    
    // Check if template exists
    try {
      await fs.access(templatePath);
    } catch (error) {
      throw new Error(`Template file not found: ${templateName}`);
    }
    
    // Read template
    const templateContent = await fs.readFile(templatePath);
    const zip = new PizZip(templateContent);
    
    let doc;
    
    if (templateType === 'step-by-step-guide') {
      // Configure with image module for step-by-step guides
      const imageModule = new ImageModule({
        centered: false,
        getImage: function(tagValue, tagName) {
          if (tagValue && tagValue.startsWith('/uploads/')) {
            const imagePath = path.join(__dirname, tagValue);
            return fs.readFile(imagePath);
          }
          return null;
        },
        getSize: function(img, tagValue, tagName) {
          return [400, 300]; // Default image size in pixels
        }
      });
      
      doc = new Docxtemplater(zip, {
        paragraphLoop: true,
        linebreaks: true,
        modules: [imageModule],
        delimiters: { start: '{', end: '}' },
        nullGetter: function(part) {
          if (!part.module) {
            return "";
          }
          if (part.module === "rawxml") {
            return "";
          }
          return "";
        }
      });
    } else {
      // Standard template without images
      doc = new Docxtemplater(zip, {
        paragraphLoop: true,
        linebreaks: true,
        delimiters: { start: '{', end: '}' }
      });
    }
    
    // Prepare template data
    let templateData = {
      guide_title: data.guide_title || data.document_title || 'Document Title',
      classification: data.classification || 'Standard',
      date: new Date().toLocaleDateString('en-GB')
    };
    
    if (templateType === 'step-by-step-guide') {
      // Handle step-by-step guide data
      templateData = {
        ...templateData,
        guide_overview: data.guide_overview || 'Guide overview not available',
        target_audience: data.target_audience || 'General users',
        prerequisites: data.prerequisites || 'No specific prerequisites',
        steps_content: data.steps_content || 'Steps not available',
        conclusion: data.conclusion || 'Conclusion not available'
      };
      
      // Process structured steps with images
      if (data.structuredSteps && Array.isArray(data.structuredSteps)) {
        const processedSteps = data.structuredSteps.map((step, index) => {
          let imageUrl = null;
          
          if (step.image && step.image.url) {
            // Handle both full URLs and relative paths
            imageUrl = step.image.url.startsWith('/uploads/') 
              ? step.image.url 
              : step.image.url.replace('http://localhost:3001', '');
          }
          
          return {
            step_number: index + 1,
            step_title: step.title || `Step ${index + 1}`,
            step_description: step.description || '',
            step_image: imageUrl,
            step_notes: step.notes || ''
          };
        });
        
        templateData.steps = processedSteps;
        
        console.log('=== PROCESSED STEPS ===');
        console.log('Number of steps:', processedSteps.length);
        console.log('Steps with images:', processedSteps.filter(s => s.step_image).length);
        console.log('Step details:', processedSteps.map(s => ({
          title: s.step_title,
          hasImage: !!s.step_image,
          imagePath: s.step_image
        })));
      } else {
        console.log('=== NO STRUCTURED STEPS ===');
        console.log('structuredSteps data:', data.structuredSteps);
        templateData.steps = [];
      }
    } else {
      // Handle standard RCA template data
      templateData = {
        ...templateData,
        document_title: data.document_title || 'Root Cause Analysis Report',
        initial_findings: data.initial_findings || 'Initial findings not available',
        executive_summary: data.executive_summary || 'Executive summary not available',
        timeline_events: data.timeline_events || 'Timeline not available',
        risk_impact: data.risk_impact || 'Risk assessment not available',
        resolution_actions: data.resolution_actions || 'Resolution actions not available',
        lessons_learned: data.lessons_learned || 'Lessons learned not available'
      };
    }
    
    console.log('=== TEMPLATE DATA ===');
    console.log('Using template:', templateName);
    console.log('Template type:', templateType);
    console.log('Final template data:', templateData);
    
    // Set data and render (Updated for newer docxtemplater)
    try {
      doc.render(templateData);
    } catch (error) {
      console.error('=== TEMPLATE RENDERING ERROR ===');
      console.error('Error details:', error);
      console.error('Error properties:', error.properties);
      
      if (error.properties && error.properties.errors) {
        console.error('Missing variables:', error.properties.errors);
      }
      
      throw new Error(`Template rendering failed: ${error.message}`);
    }
    
    const buffer = doc.getZip().generate({ type: 'nodebuffer' });
    
    return buffer;
  } catch (error) {
    console.error('DOCX generation error:', error);
    throw new Error(`Failed to generate DOCX: ${error.message}`);
  }
}

async function callAzureOpenAI(systemPrompt, userPrompt) {
  try {
    const url = `${AZURE_OPENAI_CONFIG.endpoint}/openai/deployments/${AZURE_OPENAI_CONFIG.deploymentName}/chat/completions?api-version=${AZURE_OPENAI_CONFIG.apiVersion}`;
    
    const response = await axios.post(url, {
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: userPrompt
        }
      ],
      max_tokens: 3000,
      temperature: 0.7,
      top_p: 0.9
    }, {
      headers: {
        'Content-Type': 'application/json',
        'api-key': AZURE_OPENAI_CONFIG.apiKey
      }
    });

    return response.data.choices[0].message.content;
  } catch (error) {
    console.error('Azure OpenAI API Error:', error.response?.data || error.message);
    throw new Error(`Failed to generate content: ${error.response?.data?.error?.message || error.message}`);
  }
}

// API Routes

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    azureConfigured: !!(AZURE_OPENAI_CONFIG.endpoint && AZURE_OPENAI_CONFIG.apiKey),
    availableRoutes: [
      'GET /api/health',
      'GET /api/templates', 
      'POST /api/generate-document',
      'POST /api/download-document',
      'POST /api/upload-image',
      'DELETE /api/delete-image/:filename',
      'POST /api/test-template'
    ]
  });
});

// Get available templates
app.get('/api/templates', (req, res) => {
  const templates = Object.keys(DOCUMENT_TEMPLATES).map(id => ({
    id,
    name: DOCUMENT_TEMPLATES[id].name
  }));
  res.json(templates);
});

// Image upload endpoint (FIXED)
app.post('/api/upload-image', function(req, res) {
  console.log('=== UPLOAD ROUTE HIT ===');
  console.log('Request headers:', req.headers);
  
  // Use multer upload.single() as middleware
  upload.single('image')(req, res, async function(err) {
    if (err) {
      console.error('Multer error:', err);
      return res.status(400).json({ 
        error: 'Upload failed', 
        details: err.message 
      });
    }
    
    try {
      console.log('=== IMAGE UPLOAD REQUEST ===');
      console.log('File received:', req.file);
      
      if (!req.file) {
        return res.status(400).json({ error: 'No image file provided' });
      }

      const imageUrl = `/uploads/${req.file.filename}`;
      const fullPath = path.join(__dirname, 'uploads', req.file.filename);
      
      console.log('Image saved to:', fullPath);
      console.log('Image URL:', imageUrl);

      res.json({
        success: true,
        imageUrl: imageUrl,
        filename: req.file.filename,
        originalName: req.file.originalname,
        size: req.file.size,
        fullPath: fullPath
      });

    } catch (error) {
      console.error('Image upload error:', error);
      res.status(500).json({ 
        error: 'Failed to upload image',
        details: error.message
      });
    }
  });
});

// Delete image endpoint
app.delete('/api/delete-image/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    const filePath = path.join(__dirname, 'uploads', filename);
    
    try {
      await fs.unlink(filePath);
      res.json({ success: true, message: 'Image deleted successfully' });
    } catch (error) {
      if (error.code === 'ENOENT') {
        res.status(404).json({ error: 'Image not found' });
      } else {
        throw error;
      }
    }
  } catch (error) {
    console.error('Image deletion error:', error);
    res.status(500).json({ 
      error: 'Failed to delete image',
      details: error.message
    });
  }
});

// Generate document
app.post('/api/generate-document', async (req, res) => {
  try {
    const { template, sections } = req.body;

    // Validation
    if (!template || !sections) {
      return res.status(400).json({ 
        error: 'Missing required fields: template and sections' 
      });
    }

    if (!DOCUMENT_TEMPLATES[template]) {
      return res.status(400).json({ 
        error: 'Invalid template specified' 
      });
    }

    // Check if Azure OpenAI is configured
    if (!AZURE_OPENAI_CONFIG.endpoint || !AZURE_OPENAI_CONFIG.apiKey) {
      return res.status(500).json({ 
        error: 'Azure OpenAI not configured. Please check environment variables.' 
      });
    }

    // Validate that required sections have content
    const hasContent = Object.values(sections).some(section => 
      section && section.trim().length > 0
    );

    if (!hasContent) {
      return res.status(400).json({ 
        error: 'At least one section must have content' 
      });
    }

    const templateConfig = DOCUMENT_TEMPLATES[template];
    
    console.log('=== DOCUMENT GENERATION ===');
    console.log('Template requested:', template);
    console.log('Template config found:', !!templateConfig);
    console.log('Sections received:', Object.keys(sections));
    console.log('Structured steps:', sections.structuredSteps);
    
    if (!templateConfig) {
      console.log('Available templates:', Object.keys(DOCUMENT_TEMPLATES));
      return res.status(400).json({ 
        error: 'Invalid template specified',
        requestedTemplate: template,
        availableTemplates: Object.keys(DOCUMENT_TEMPLATES)
      });
    }
    
    console.log('Template docx file:', templateConfig.docxTemplate);
    const systemPrompt = templateConfig.systemPrompt;
    const userPrompt = templateConfig.generatePrompt(sections);

    // Generate content using Azure OpenAI
    const generatedContent = await callAzureOpenAI(systemPrompt, userPrompt);
    
    // Parse AI response based on template type
    let parsedSections;
    if (template === 'step-by-step-guide') {
      parsedSections = parseStepByStepResponse(generatedContent);
      
      // Add structured steps data if available
      if (sections.structuredSteps) {
        parsedSections.structuredSteps = sections.structuredSteps;
      }
    } else {
      parsedSections = parseAIResponse(generatedContent);
    }

    // Log the generation for debugging
    console.log(`Document generated for template: ${template}`);
    console.log(`Content parsed into ${Object.keys(parsedSections).length} sections`);

    res.json({
      success: true,
      document: {
        id: `doc_${Date.now()}`,
        template: template,
        title: `${templateConfig.name} - ${new Date().toLocaleDateString()}`,
        content: generatedContent,
        parsedSections: parsedSections,
        generatedAt: new Date().toISOString(),
        originalSections: sections
      }
    });

  } catch (error) {
    console.error('Document generation error:', error);
    res.status(500).json({ 
      error: 'Failed to generate document',
      details: error.message
    });
  }
});

// Download document as DOCX
app.post('/api/download-document', async (req, res) => {
  try {
    const { documentId, template, parsedSections } = req.body;

    if (!template || !parsedSections) {
      return res.status(400).json({ 
        error: 'Missing required fields: template and parsedSections' 
      });
    }

    const templateConfig = DOCUMENT_TEMPLATES[template];
    if (!templateConfig || !templateConfig.docxTemplate) {
      return res.status(400).json({ 
        error: 'No DOCX template configured for this document type' 
      });
    }

    // Generate DOCX
    const templateType = template === 'step-by-step-guide' ? 'step-by-step-guide' : 'standard';
    const docxBuffer = await generateDocxFromTemplate(templateConfig.docxTemplate, parsedSections, templateType);
    
    // Set response headers for file download
    const filename = `${templateConfig.name.replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.docx`;
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', docxBuffer.length);
    
    res.send(docxBuffer);

  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ 
      error: 'Failed to generate download',
      details: error.message
    });
  }
});

// Test template endpoint
app.post('/api/test-template', async (req, res) => {
  try {
    const { template } = req.body || {};
    const templateName = template || 'step-by-step-guide-template.docx';
    const templatePath = path.join(__dirname, 'templates', templateName);
    
    console.log('=== TESTING TEMPLATE ===');
    console.log('Template name:', templateName);
    console.log('Template path:', templatePath);
    
    // Check if template exists
    try {
      await fs.access(templatePath);
      console.log('✅ Template file exists');
    } catch (error) {
      console.log('❌ Template file not found');
      return res.status(404).json({ 
        error: 'Template file not found',
        templatePath: templatePath,
        templateName: templateName
      });
    }
    
    // Read and test template
    const templateContent = await fs.readFile(templatePath);
    const zip = new PizZip(templateContent);
    const doc = new Docxtemplater(zip);
    
    // Test with simple data
    const testData = {
      guide_title: 'TEST GUIDE TITLE',
      date: 'TEST DATE',
      guide_overview: 'TEST OVERVIEW',
      target_audience: 'TEST AUDIENCE',
      prerequisites: 'TEST PREREQUISITES',
      steps_content: 'TEST STEPS',
      conclusion: 'TEST CONCLUSION'
    };
    
    doc.setData(testData);
    
    try {
      doc.render();
      
      // Generate test document
      const buffer = doc.getZip().generate({ type: 'nodebuffer' });
      
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', 'attachment; filename="template-test.docx"');
      res.send(buffer);
      
    } catch (renderError) {
      console.error('Template render error:', renderError);
      res.status(500).json({ 
        error: 'Template rendering failed', 
        details: renderError.message,
        missingVariables: renderError.properties?.errors || []
      });
    }
    
  } catch (error) {
    console.error('Template test error:', error);
    res.status(500).json({ error: 'Template test failed', details: error.message });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ 
    error: 'Internal server error',
    details: error.message
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 AI Document Writer Server running on port ${PORT}`);
  console.log(`📝 API Base URL: http://localhost:${PORT}/api`);
  console.log(`🔑 Azure OpenAI configured: ${!!(AZURE_OPENAI_CONFIG.endpoint && AZURE_OPENAI_CONFIG.apiKey)}`);
  
  if (!AZURE_OPENAI_CONFIG.endpoint || !AZURE_OPENAI_CONFIG.apiKey) {
    console.log('⚠️  Warning: Azure OpenAI not configured. Please set environment variables.');
  }
});

module.exports = app;