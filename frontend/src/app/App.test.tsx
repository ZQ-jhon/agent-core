import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { App } from './App.tsx'

describe('Stage 1 engineering shell', () => {
  it('renders the delivery boundary without exposing business UI', () => {
    render(<App />)

    expect(
      screen.getByRole('heading', { name: 'Stage 1 engineering shell' }),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/No Schema runtime, business actions, Upload, Markdown/),
    ).toBeInTheDocument()
  })
})
