"use client";

import React, { useEffect, useRef } from "react";

export default function BackgroundCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animationFrameId: number;
    let time = 0;

    const chars = "01アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン";
    const matrixDrops: { x: number; y: number; speed: number; char: string; opacity: number }[] = [];
    const hexNodes: { x: number; y: number; vx: number; vy: number; connections: number[] }[] = [];
    const particles: { x: number; y: number; vx: number; vy: number; life: number; maxLife: number }[] = [];

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;

      matrixDrops.length = 0;
      const columns = Math.floor(canvas.width / 20);
      for (let i = 0; i < columns; i++) {
        matrixDrops.push({
          x: i * 20,
          y: Math.random() * canvas.height,
          speed: 1 + Math.random() * 3,
          char: chars[Math.floor(Math.random() * chars.length)],
          opacity: 0.1 + Math.random() * 0.3,
        });
      }

      hexNodes.length = 0;
      const nodeCount = Math.floor((canvas.width * canvas.height) / 50000);
      for (let i = 0; i < nodeCount; i++) {
        hexNodes.push({
          x: Math.random() * canvas.width,
          y: Math.random() * canvas.height,
          vx: (Math.random() - 0.5) * 0.5,
          vy: (Math.random() - 0.5) * 0.5,
          connections: [],
        });
      }
    };

    window.addEventListener("resize", resize);
    resize();

    const render = () => {
      time += 0.01;
      const { width, height } = canvas;

      ctx.fillStyle = "rgba(10, 10, 15, 0.15)";
      ctx.fillRect(0, 0, width, height);

      ctx.font = "14px JetBrains Mono, monospace";
      matrixDrops.forEach((drop) => {
        const gradient = ctx.createLinearGradient(drop.x, drop.y - 100, drop.x, drop.y);
        gradient.addColorStop(0, "transparent");
        gradient.addColorStop(0.5, `rgba(20, 241, 149, ${drop.opacity * 0.3})`);
        gradient.addColorStop(1, `rgba(20, 241, 149, ${drop.opacity})`);

        ctx.fillStyle = gradient;
        ctx.fillText(drop.char, drop.x, drop.y);

        drop.y += drop.speed;
        if (drop.y > height) {
          drop.y = -20;
          drop.char = chars[Math.floor(Math.random() * chars.length)];
        }

        if (Math.random() < 0.02) {
          drop.char = chars[Math.floor(Math.random() * chars.length)];
        }
      });

      hexNodes.forEach((node, i) => {
        node.x += node.vx;
        node.y += node.vy;

        if (node.x < 0 || node.x > width) node.vx *= -1;
        if (node.y < 0 || node.y > height) node.vy *= -1;

        hexNodes.forEach((other, j) => {
          if (i >= j) return;
          const dx = other.x - node.x;
          const dy = other.y - node.y;
          const dist = Math.sqrt(dx * dx + dy * dy);

          if (dist < 150) {
            const opacity = (1 - dist / 150) * 0.3;
            ctx.beginPath();
            ctx.strokeStyle = `rgba(153, 69, 255, ${opacity})`;
            ctx.lineWidth = 1;
            ctx.moveTo(node.x, node.y);
            ctx.lineTo(other.x, other.y);
            ctx.stroke();
          }
        });

        ctx.beginPath();
        ctx.fillStyle = `rgba(0, 212, 255, ${0.3 + Math.sin(time + i) * 0.2})`;
        ctx.arc(node.x, node.y, 2, 0, Math.PI * 2);
        ctx.fill();
      });

      if (Math.random() < 0.1) {
        particles.push({
          x: Math.random() * width,
          y: Math.random() * height,
          vx: (Math.random() - 0.5) * 2,
          vy: (Math.random() - 0.5) * 2,
          life: 0,
          maxLife: 60 + Math.random() * 60,
        });
      }

      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.life++;

        const lifeRatio = 1 - p.life / p.maxLife;
        ctx.beginPath();
        ctx.fillStyle = `rgba(20, 241, 149, ${lifeRatio * 0.5})`;
        ctx.arc(p.x, p.y, 1 + lifeRatio * 2, 0, Math.PI * 2);
        ctx.fill();

        if (p.life >= p.maxLife) {
          particles.splice(i, 1);
        }
      }

      const g1X = width * 0.3;
      const g1Y = height * 0.3;
      const grad1 = ctx.createRadialGradient(g1X, g1Y, 0, g1X, g1Y, width * 0.5);
      grad1.addColorStop(0, "rgba(153, 69, 255, 0.08)");
      grad1.addColorStop(1, "transparent");
      ctx.fillStyle = grad1;
      ctx.fillRect(0, 0, width, height);

      const g2X = width * 0.7;
      const g2Y = height * 0.7;
      const grad2 = ctx.createRadialGradient(g2X, g2Y, 0, g2X, g2Y, width * 0.4);
      grad2.addColorStop(0, "rgba(20, 241, 149, 0.05)");
      grad2.addColorStop(1, "transparent");
      ctx.fillStyle = grad2;
      ctx.fillRect(0, 0, width, height);

      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      window.removeEventListener("resize", resize);
      cancelAnimationFrame(animationFrameId);
    };
  }, []);

  return (
    <div className="fixed inset-0 w-full h-full -z-10 pointer-events-none overflow-hidden bg-[#0a0a0f]">
      <canvas
        ref={canvasRef}
        className="w-full h-full block"
      />

      <div
        className="absolute inset-0 w-full h-full opacity-60"
        style={{
          background: "radial-gradient(ellipse at 50% 0%, rgba(153, 69, 255, 0.15) 0%, transparent 50%)",
        }}
      />

      <div
        className="absolute inset-0 w-full h-full"
        style={{
          background: "radial-gradient(circle at 50% 100%, rgba(20, 241, 149, 0.1) 0%, transparent 40%)",
        }}
      />

      <div
        className="absolute inset-0 w-full h-full pointer-events-none"
        style={{
          backgroundImage: `
            linear-gradient(rgba(20, 241, 149, 0.03) 1px, transparent 1px),
            linear-gradient(90deg, rgba(20, 241, 149, 0.03) 1px, transparent 1px)
          `,
          backgroundSize: "50px 50px",
        }}
      />
    </div>
  );
}
