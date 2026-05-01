// Стартовый файл для примера использования API

const sampleCaseData = {
  id: "case-001",
  title: "Корпоративный спор: Реорганизация ООО",
  description: "Вы являетесь юридическим консультантом компании, которая планирует реорганизацию. Ваша задача - провести все необходимые этапы в соответствии с законодательством.",
  stages: [
    {
      id: 1,
      title: "Подготовка документации",
      phases: [
        {
          id: 1,
          title: "Анализ текущего состояния",
          actions: [
            { id: "1", text: "Действие 1", impact: { resources: -10, lexic: { confidence: 5 } } }
          ]
        }
      ]
    }
  ]
};

// API использование
async function getCase() {
  try {
    const response = await fetch('/api/case');
    const data = await response.json();
    console.log('Case loaded:', data);
  } catch (error) {
    console.error('Error:', error);
  }
}

async function submitProgress(progress) {
  try {
    const response = await fetch('/api/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(progress)
    });
    const data = await response.json();
    console.log('Progress saved:', data);
  } catch (error) {
    console.error('Error:', error);
  }
}

// Экспорт для использования в компонентах
module.exports = { getCase, submitProgress, sampleCaseData };
